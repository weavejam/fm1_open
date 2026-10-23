// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page (/plugin/): FM1 Open's device and the workbench's parts around it (device.js, panel.js) on an FM1
// Open of its own (fm1open.wasm in an AudioWorklet, worklet-tutti.js), with tuttidaw's protocol (tutti-plugin/0,
// protocol.js). After weavejam's FM-1 plugins (web/plugin/tutti.js).
//   - in tuttidaw's iframe: the handshake; `init` gives the state this FM1 starts with (no saves in this browser); the
//     host's tempo and transport drive its preview; edits make new state revisions (state-changed); "Render to
//     tuttidaw" sends `commit` (the pattern's length in lengthBeats); renders run in a Worker (render-worker.js); mode
//     'render': headless, nothing else runs.
//   - opened by itself (or not connected within a few seconds): the device on this page's FM1, its state kept in this
//     browser, a note that it is a tuttidaw plugin.
// The layout fits any frame, never a page scrollbar (layout below).
import { PluginSession, embedderAllowed } from "./protocol.js";
import { FM1Engine, PreviewTempo } from "./engine.js";
import { RenderError } from "./renderer.js";
import { packState, unpackState, STATE_VERSION, bootDevice, deviceState } from "./state.js";
import { createDevice } from "./device.js";
import { createPanel } from "./panel.js";
import { BUILD, EMBEDDERS } from "./build-info.js";

const embedded = window.parent !== window;
const WASM_URL = new URL("fm1open.wasm", import.meta.url).href;
const STORE_KEY = "fm1open-tutti-standalone";          // (opened by itself: the state in this browser)
const log = (...a) => console.debug(...a);
const $ = (id) => document.getElementById(id);
const T = (node, text) => globalThis.FM1I18n.text(node, text);
let standalone = !embedded, hosted = false;

// ------------------------------------------------------------------ the layout: the frame, whatever its size
// The page fills the frame and never scrolls as a whole (tuttidaw opens it wide on a desktop, at any size the user
// drags it to, >= 480 x 360; a phone's sheet is tall). The device is drawn in container units (device.css: cqw of its
// box), so its box is sized here and the drawing and its hit areas follow, crisp at any size:
//   - wide (aspect >= 1.3, >= 900 px): the device as large as fits on the left, the companion panel (panel.js: the
//     project, the eight track lanes with their steps and levels, the edit pages, samples, files) on the right;
//   - tall (taller than 1.15 x wide): the device across the top, the panel under it;
//   - otherwise the device alone, scaled to fit, the bar over it.
// The panel's sections scroll on their own when the frame is short (no scrollbars drawn). The host gets the wide
// layout's size (1280 x 800) as the size this page prefers (resize, a hint).
export const PREFERRED = { width: 1280, height: 800 };
const DEVICE_ASPECT = 1000 / 624;
function layout() {
  const W = window.innerWidth, H = window.innerHeight, root = document.documentElement;
  const wide = W >= 900 && W / H >= 1.3, tall = !wide && H / W >= 1.15;
  root.classList.toggle("tt-wide", wide);
  root.classList.toggle("tt-tall", tall);
  root.classList.toggle("tt-compact", !wide && !tall);
  const bar = $("tt-bar").offsetHeight, foot = $("tt-foot").offsetHeight, pad = W < 600 ? 8 : 14;
  const availH = H - bar - foot - 2 * pad;
  let w;
  if (wide) {
    const side = Math.min(560, Math.max(340, W * 0.34));
    w = Math.min(W - side - 3 * pad, availH * DEVICE_ASPECT);
    $("tt-side").style.width = `${Math.floor(W - w - 3 * pad)}px`;
  } else if (tall) {
    w = Math.min(W - 2 * pad, (availH * 0.55) * DEVICE_ASPECT);
    $("tt-side").style.width = "";
  } else w = Math.min(W - 2 * pad, availH * DEVICE_ASPECT);
  $("sim-device").style.width = `${Math.max(120, Math.floor(w))}px`;
}

// ------------------------------------------------------------------ the bar
globalThis.FM1I18n.scan(document.body);                // (the page's own texts: I18n.js ran before the body was there)
const note = (t) => { if ($("tt-note")) T($("tt-note"), t); };
$("tt-source-link").href = BUILD.source;
$("tt-source-link").title = BUILD.source;               // (as text too: tuttidaw's frame opens no popups)

// ------------------------------------------------------------------ the live FM1 (edit mode, standalone)
let projectName = null, ac = null, node = null, wasmBytes = null, wasmModule = null, ready = false, loads = 0, sigBase = null, seq = 0;
const waits = new Map();
const status = window.fm1Plugin = { ready: false, sig: 0, frames: 0 };   // (what the page's FM1 does, to look at)
const post = (m, transfer) => { if (node) node.port.postMessage(m, transfer || []); };
const tempo = new PreviewTempo((bpm) => post({ type: "tutti-tempo", bpm }));
function send(type, args = {}) { if (ready) post({ type: "cmd", cmd: { type, ...args } }); }
function request(type, args = {}) {
  if (!ready) return Promise.reject(Error("仿真尚未载入"));
  const id = ++seq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { waits.delete(id); rej(Error("仿真操作超时")); }, 7000);
    waits.set(id, (m) => { clearTimeout(timer); m.error ? rej(Error(m.error)) : res(m.data); });
    post({ type: "cmd", id, cmd: { type, ...args } });
  });
}
function ask(type, extra = {}) {                       // the worklet's tutti requests (snapshot, steps)
  const id = ++seq;
  return new Promise((res, rej) => {
    waits.set(id, res);
    post({ type, id, ...extra });
    setTimeout(() => { if (waits.delete(id)) rej(new RenderError("internal", "FM1 Open did not answer")); }, 5000);
  });
}
const say = (text) => note(text);
const device = createDevice({ root: $("sim-device"), send, request, say, start: () => startAudio() });
const panel = createPanel({ root: $("tt-side"), send, request, say, encode, save, start: () => startAudio() });
device.onVolume((v) => send("control", { kind: 3, index: 0, value: Math.round(v * 1023 / 100) }));

function onNode(e) {
  const m = e.data;
  if (m.type === "frame") {
    status.frames++;
    if (m.workspace) projectName = m.workspace.name;
    device.receive(m);
    panel.receive(m);
    const playing = status.playing = !!m.state[14];
    if ($("tt-play").getAttribute("aria-pressed") !== String(playing)) {
      $("tt-play").setAttribute("aria-pressed", String(playing));
      T($("tt-play"), playing ? "停止" : "播放");
    }
  } else if (m.type === "ready") {
    ready = status.ready = true;
    sigBase = status.sig = m.sig;
    tempo.reset();
    tempo.at(0);
    device.setReady(true);
    panel.setReady(true, m.factories);
    for (const b of document.querySelectorAll("[data-ready]")) b.disabled = false;
  } else if (m.type === "sig") {
    if (sigBase !== null && m.sig !== sigBase) changed();
    sigBase = status.sig = m.sig;
  } else if (m.type === "reply" || m.type === "snapshot" || m.type === "steps") {
    const w = waits.get(m.id);
    waits.delete(m.id);
    if (w) w(m);
  } else if (m.type === "error") {
    note(`FM1 Open: ${m.message}`);
    console.error("fm1 worklet:", m.message);
  }
}

async function wasm() {
  if (!wasmBytes) {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error(`fm1open.wasm: ${res.status}`);
    wasmBytes = await res.arrayBuffer();
  }
  if (!wasmModule) wasmModule = await WebAssembly.compile(wasmBytes);
  return wasmModule;
}
// a new FM1's state (engine init without a state): booted in an instance of its own, as the workbench starts
async function blank() {
  const { exports: ex } = await WebAssembly.instantiate(await wasm(), {});
  ex._initialize();
  bootDevice(ex, null);
  return deviceState(ex);
}
async function ensureAudio() {
  if (ac) return;
  ac = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
  await ac.audioWorklet.addModule(new URL("./worklet-tutti.js", import.meta.url));
  node = new AudioWorkletNode(ac, "fm1-tutti", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.port.onmessage = onNode;
  node.onprocessorerror = () => note("FM1 Open's audio stopped (reload the page).");
  node.connect(ac.destination);
  await wasm();
}
// the browser lets a page play sound after a gesture: FM1 runs (its clock is the audio's) once the context runs
function audioState() {
  const on = ac && ac.state === "running";
  $("tt-audio").hidden = !ac || on;
  if (ac && !on) note("Press “Start audio”: the browser waits for a click before a page plays sound.");
  else if (on && /Start audio/.test($("tt-note").textContent)) note("");
}
async function startAudio() {
  if (!ac || ac.state === "running") return;
  try { await ac.resume(); } catch {}
  audioState();
}
for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => { if (ac && ac.state !== "running") startAudio(); }, true);

let current = null;
const live = {
  async load(state, context) {
    loads++;
    current = state;
    this.context(context);
    ready = status.ready = false;
    device.setReady(false);
    panel.setReady(false);
    await ensureAudio();
    const first = !node.loaded;
    node.loaded = true;
    post({ type: "load", wasm: first ? wasmBytes.slice(0) : null, state, hosted, knob: 1023 });
    if (ac.state !== "running") ac.resume().then(audioState, () => {});   // (not awaited: init never waits for a gesture)
    ac.onstatechange = audioState;
    audioState();
  },
  async snapshot() {
    if (!node || !ready) return current;              // (not on yet: nothing changed)
    const load = loads;
    const m = await ask("snapshot");
    if (load !== loads) return m.state;               // (a state loaded since: it stays)
    sigBase = m.sig;
    current = m.state;
    return current;
  },
  context(ctx) { tempo.context(ctx); },
  transport(t) {
    if (!node || !ac) return;
    tempo.at(t.beat);
    if (!t.playing) { post({ type: "tutti-play", gen: t.generation, playing: false }); return; }
    // the context frame heard at atEpochMs: by the output's timestamp (it has the output latency) where there is one
    let atCtx;
    const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) atCtx = ts.contextTime + (t.atEpochMs - (performance.timeOrigin + ts.performanceTime)) / 1000;
    else atCtx = ac.currentTime + (t.atEpochMs - (performance.timeOrigin + performance.now())) / 1000 - (ac.outputLatency || ac.baseLatency || 0);
    post({ type: "tutti-play", gen: t.generation, playing: true, atFrame: Math.round(atCtx * ac.sampleRate), beat: t.beat, bpm: tempo.bpm });
  },
  close() { post({ type: "tutti-play", gen: -1, playing: false }); },
};

// the state changed: a new revision for the session; opened by itself, kept in this browser (once still for 1.5 s)
let saveTimer = 0;
function changed() {
  if (standalone) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 1500);
  } else engine.changed();
}
async function saveLocal() {
  try {
    const st = await live.snapshot();
    if (!st) return;
    const u8 = new Uint8Array(packState(st));
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    localStorage.setItem(STORE_KEY, btoa(bin));
  } catch (err) { log("fm1open: not saved in this browser", err); }
}
function loadLocal() {
  try {
    const b = localStorage.getItem(STORE_KEY);
    if (!b) return null;
    const bin = atob(b), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return unpackState(u8.buffer, STATE_VERSION);
  } catch { return null; }
}
function save(bytes, name) {                           // (a sandboxed frame has no downloads: opened by itself they work)
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })), a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Render to tuttidaw: one pass of the pattern (until every track's loop meets again: tutti_pattern_steps), the stems if
// asked; lengthBeats (protocol 4b) the same length, the "whole plugin song"
async function commit() {
  let steps = 0;
  try { steps = (await ask("steps")).steps; } catch {}
  const outputs = $("tt-stems").checked ? ["mix", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] : ["mix"];
  const beats = steps / 4;
  session.commit(beats > 0 ? { fromBeat: 0, toBeat: beats, outputs, lengthBeats: beats } : { outputs });
}

// ------------------------------------------------------------------ work in Workers
// renders: one at a time in a worker; one still running when another starts (its session ended meanwhile: it is let
// go, not waited for) goes with its worker, and the new one gets a fresh worker. The session's end (close, the port's
// messageerror) or a message between it and the page that cannot be read (messageerror, either way): the worker's work
// ended with it (stopWorker)
let worker = null, workerBusy = null;
function stopWorker(err = new RenderError("cancelled", "the session ended")) {
  if (worker && workerBusy) {
    worker.terminate();
    workerBusy(err);
    worker = null;
  }
}
function renderInWorker(state, req, sink) {
  // (an ended session's render, its state made late: it never touches the worker, the next session's render may be in it)
  if (sink.cancelled()) return Promise.reject(new RenderError("cancelled", "cancelled"));
  stopWorker();
  worker = worker || new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  const w = worker;
  $("tt-render").hidden = false;
  $("tt-progress").value = 0;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (sink.cancelled()) w.postMessage({ type: "cancel" }); }, 50);
    const end = () => { clearInterval(poll); w.onmessage = w.onmessageerror = null; workerBusy = null; $("tt-render").hidden = true; };
    const unreadable = () => {                         // (the session ends: its teardown stops this worker, see close)
      log("tutti: a render worker message could not be read");
      session.close();
      stopWorker(new RenderError("internal", "a render worker message could not be read"));
    };
    w.onmessageerror = unreadable;
    workerBusy = (err) => { end(); reject(err); };
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === "chunk") {
        try {
          await sink.chunk(m.output, m.frameOffset, m.channels);
          w.postMessage({ type: "ack" });
        } catch {
          w.postMessage({ type: "cancel" });
        }
      } else if (m.type === "progress") {
        $("tt-progress").value = m.fraction;
        sink.progress(m.fraction);
      } else if (m.type === "done") { end(); resolve(m.result); }
      else if (m.type === "error") { end(); reject(new RenderError(m.code, m.message)); }
      else if (m.type === "messageerror") unreadable();
    };
    w.onerror = (e) => { end(); worker = null; w.terminate(); reject(new RenderError("internal", e.message || "the render worker failed")); };
    w.postMessage({ type: "render", wasmUrl: WASM_URL, state, req });
  });
}
// a sample's SEA5 coding (panel.js): in a worker of its own (the same script, render-worker.js)
function encode(pcm) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
    const done = (fn, x) => { clearTimeout(timer); w.terminate(); fn(x); };
    const timer = setTimeout(() => done(reject, Error("编码超时，请缩短音频后重试")), 120000);
    w.onmessage = (e) => e.data.type === "encoded" ? done(resolve, e.data.data) : done(reject, Error(e.data.message || "SEA5 编码失败"));
    w.onerror = () => done(reject, Error("编码线程失败"));
    w.postMessage({ type: "encode", wasmUrl: WASM_URL, pcm }, [pcm.buffer]);
  });
}

// ------------------------------------------------------------------ the session
const engine = new FM1Engine({
  render: renderInWorker,
  blank,
  live,
  onChanged: (rev) => session.stateChanged(rev),
  name: () => (hosted && projectName) || null,          // (get-state summary: the project's name)
});
const session = new PluginSession({
  engine,
  post: (m) => window.parent.postMessage(m, "*"),
  allow: (origin) => embedderAllowed(origin, EMBEDDERS),   // (the build's channel: site.mjs PLUGIN_CHANNEL)
  plugin: { id: BUILD.id, version: BUILD.version, build: BUILD.build },
  log,
});
const initOrig = engine.init.bind(engine);
engine.init = async (args) => {
  clearTimeout(alone);
  if (args.mode === "render") {
    document.documentElement.classList.add("tt-headless");
    note("Rendering for tuttidaw (headless).");
  } else {
    hosted = true;
    $("tt-connected").hidden = false;
    note("Connected to tuttidaw.");
  }
  return initOrig(args);
};

function becomeStandalone() {
  standalone = true;
  session.stopAccepting();                             // (a late connect would find FM1 on this browser's state)
  note("This is the FM1 Open plugin for tuttidaw. Opened by itself it is FM1 Open in your browser: its state stays in this browser.");
  const st = loadLocal();
  (st ? Promise.resolve(st) : blank()).then((s) => live.load(s, null)).catch((err) => note(`FM1 Open: ${err.message || err}`));
}

$("tt-audio").addEventListener("click", () => startAudio());
$("tt-commit").addEventListener("click", () => commit());
$("tt-play").addEventListener("click", () => { startAudio(); send("control", { kind: 0, index: 12, value: 1 }); send("control", { kind: 0, index: 12, value: 0 }); });
$("tt-panic").addEventListener("click", () => { device.release(); send("panic"); });
$("tt-tap").addEventListener("click", () => send("tapTempo"));
$("tt-vol").addEventListener("input", () => device.master.set(+$("tt-vol").value));
layout();
window.addEventListener("resize", layout);
new ResizeObserver(layout).observe($("tt-bar"));
engine.close = () => {                                 // (the session's end: the live FM1 stopped, a render's worker too)
  stopWorker();
  live.close();
};

let alone = 0;
if (embedded) {
  note("Waiting for tuttidaw…");
  // the size this page prefers, once connected: the wide layout's (a hint: the page fits any frame, see layout)
  window.addEventListener("message", (e) => {
    if (session.onWindowMessage({ data: e.data, origin: e.origin, isParent: e.source === window.parent, ports: e.ports })) {
      note("Connected to tuttidaw.");
      session.resize(PREFERRED.width, PREFERRED.height);
    }
  });
  session.hello();
  alone = setTimeout(() => { if (!session.port) becomeStandalone(); }, 4000);   // (not tuttidaw's frame)
} else becomeStandalone();
window.addEventListener("pagehide", () => { if (standalone && ready) saveLocal(); session.close(); });
