// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The FM1 Open plugin (web/plugin) in Node, after weavejam's FM-1 plugins (web/plugin/plugin_test.mjs): FM1 Open made
// and edited the way the page does it (the workbench's operations, Simulator.c sim_*, on the plugin's wasm), the
// renderer against the wasm, and the protocol against a fake host over a MessageChannel (protocol-v0 11, the plugin's
// side). Waits are for conditions (until), not for times a fast machine could outrun.
//   node web/plugin/plugin_test.mjs [build/plugin-wasm/fm1open.wasm]
// FAST=1 skips the slow checks (64 bars, 48 kHz quality).
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync, execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { render, planRender, midiEvents, device, frameAt, MIN_BPM, MAX_BPM, BLOCK } from "./renderer.js";
import { packState, unpackState, stateEquals, bootDevice, deviceState, flashSectors, STATE_VERSION, FLASH_BYTES, PROJECT_BYTES } from "./state.js";
import { PluginSession, embedderAllowed, CHANNELS, PROTOCOL, INITIAL_CREDITS } from "./protocol.js";
import { FM1Engine, PreviewTempo } from "./engine.js";
import { Resampler } from "./resample.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wasmPath = process.argv[2] || path.join(ROOT, "build/plugin-wasm/fm1open.wasm");
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const FAST = process.env.FAST === "1";
let fails = 0;
const check = (what, ok) => { console.log(`plugin: ${what.padEnd(100)} ${ok ? "ok" : "FAIL"}`); if (!ok) fails++; };
const tm = (bpm, more = []) => ({ tempoPoints: [{ beat: 0, bpm, ramp: "step" }, ...more], signatures: [{ beat: 0, numerator: 4, denominator: 4 }] });
const ctxOf = (bpm, more) => ({ timeMap: tm(bpm, more), key: null });
const req = (o) => ({ renderId: "r", stateRevision: 1, context: ctxOf(120), input: null, fromBeat: 0, toBeat: 8, tailMs: 0,
                      outputs: ["mix"], sampleRate: 44100, ...o });
const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));
const db = (x) => (20 * Math.log10(x)).toFixed(1);
const same = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const STEMS = ["t1", "t2", "t3", "t4", "t5", "t67", "t8"], ALL = ["mix", ...STEMS];   // (protocol v0: 8 outputs at most)
const NOTHING = { notes: [], cc: [], pitchBend: [], preRollBeats: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a condition, polled (never a fixed time a fast machine could outrun): resolves when it holds, rejects after `ms`
const until = async (pred, ms = 60000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout waiting"); await sleep(5); }
};

// ---- a project as the workbench's file has it (instrument.h struct groove_project, v4, + the "FM1T" tuning tail)
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const STEP = (t, s) => (t * 64 + s) * 4, PRESET = (t) => 2048 + t * 223, TEMPO = 3832, MUTE = 3834, SOLO = 3835, SEQ = 3852, ARP = 4048;
class Project {
  constructor(bytes) { this.b = Uint8Array.from(bytes); this.dv = new DataView(this.b.buffer); }
  clear() { for (let t = 0; t < 8; t++) for (let s = 0; s < 64; s++) { const p = this.pads(t); this.b.set([p ? 0 : 60, 0, 0, 0], STEP(t, s)); } return this; }
  pads(t) { const ty = this.b[PRESET(t)]; return ty === 2 || ty === 5; }
  type(t) { return this.b[PRESET(t)]; }
  note(t, s, note, vel = 100, flags = 0) { this.b.set([note, vel], STEP(t, s)); this.dv.setUint16(STEP(t, s) + 2, flags, true); return this; }
  hit(t, s, padMask, vel = 110) { this.b.set([0, vel], STEP(t, s)); this.dv.setUint16(STEP(t, s) + 2, padMask, true); return this; }
  length(t, steps) { this.b[PRESET(t) + 221] = steps === 64 ? 0 : steps / 16; return this; }
  mute(mask) { this.b[MUTE] = mask; return this; }
  swing(v) { this.b[SEQ + 1] = v; return this; }
  metronome(v) { this.b[SEQ + 2] = v; return this; }
  tempo(bpm) { this.dv.setUint16(TEMPO, bpm, true); return this; }
  sends(t, rev, dly) { this.b[PRESET(t) + 220] = rev | (dly << 4); return this; }
  arp(t, { on = 1, hold = 0, rate = 2, mode = 0 } = {}) { this.b[ARP + t * 2] = rate | (mode << 2) | (1 << 6); this.b[ARP + t * 2 + 1] = (hold << 6) | (on << 7); return this; }
  tuning(t, cents) { this.tune = this.tune || new Int8Array(192); this.tune.set(cents, t * 24); return this; }
  bytes() {
    const out = new Uint8Array(PROJECT_BYTES);
    out.set(this.b.subarray(0, 4064));
    const dv = new DataView(out.buffer);
    dv.setUint32(4064, 0x54314d46, true);
    if (this.tune) out.set(new Uint8Array(this.tune.buffer), 4068);
    dv.setUint32(4260, crc32(out.subarray(4064, 4260)), true);
    return out;
  }
}

// a live FM1 Open as the page has it (worklet-tutti.js): the workbench's operations, its clock the frames rendered
class Dev {
  static async make(state = null, { hosted = false } = {}) {
    const { exports: ex } = await WebAssembly.instantiate(mod, {});
    ex._initialize();
    bootDevice(ex, state, { hosted });
    return new Dev(ex);
  }
  constructor(ex) { this.ex = ex; }
  run(ms) { for (let k = 0; k < ms * 44.1; k += 128) this.ex.sim_render(); }
  file(bytes) { new Uint8Array(this.ex.memory.buffer, this.ex.sim_file(), bytes.length).set(bytes); }
  project() { if (this.ex.sim_export()) throw new Error("export"); return new Project(new Uint8Array(this.ex.memory.buffer, this.ex.sim_file(), PROJECT_BYTES)); }
  load(project) { this.file(project.bytes()); const r = this.ex.sim_import(PROJECT_BYTES); if (r) throw new Error(`import ${r}`); return this; }
  factory(i) { if (this.ex.sim_factory_project(i) || this.ex.sim_import(PROJECT_BYTES)) throw new Error("factory"); return this; }
  state() { return deviceState(this.ex); }
  flash() { return new Uint8Array(this.ex.memory.buffer, this.ex.sim_flash(), FLASH_BYTES); }
  // a user sample into slot `slot` (the page's samples command: SEA5-coded, the bank into the flash)
  sample(slot, pcm, name) {
    const ex = this.ex, at = ex.sim_sample_alloc(pcm.length);
    new Int16Array(ex.memory.buffer, at, pcm.length).set(pcm);
    const p = ex.sim_sample_encode(), n = ex.sim_sample_bytes(), data = new Uint8Array(ex.memory.buffer, p, n).slice();
    const OFF = 69632, bank = this.flash().slice(OFF, OFF + 446464), size = new DataView(bank.buffer).getUint32(8, true);
    // the bank as sdk/Samples.js packs it: slot `slot` replaced
    const v = new DataView(bank.buffer), entries = [];
    for (let i = 0; i < 16; i++) { const o = v.getUint32(32 + i * 28, true), fr = v.getUint32(36 + i * 28, true), by = v.getUint32(40 + i * 28, true);
      entries.push({ name: bank.slice(44 + i * 28, 60 + i * 28), frames: fr, data: bank.slice(o, o + by) }); }
    entries[slot] = { name: Uint8Array.from(name.padEnd(16, "\0").slice(0, 15) + "\0", (c) => c.charCodeAt(0)), frames: pcm.length, data };
    const total = 512 + entries.reduce((s, e) => s + e.data.length, 0), out = new Uint8Array(total), ov = new DataView(out.buffer);
    out.set(bank.subarray(0, 32));
    ov.setUint32(8, total, true);
    let off = 512;
    entries.forEach((e, i) => { ov.setUint32(32 + i * 28, off, true); ov.setUint32(36 + i * 28, e.frames, true); ov.setUint32(40 + i * 28, e.data.length, true); out.set(e.name, 44 + i * 28); out.set(e.data, off); off += e.data.length; });
    // the bank's CRC (sdk/Samples.js crc: header bytes 0..11, 8 zero bytes, then 20..)
    const c = (() => { let x = -1; const feed = (b) => { for (const y of b) x = CRC[(x ^ y) & 255] ^ (x >>> 8); }; feed(out.subarray(0, 12)); feed(new Uint8Array(8)); feed(out.subarray(20)); return (x ^ -1) >>> 0; })();
    ov.setUint32(12, c, true);
    if (size < 512) throw new Error("no bank");
    const flash = this.flash().subarray(OFF, OFF + 466944);
    flash.fill(255, 0, 446464);
    flash.set(out);
    if (ex.sim_sample_bank(out.length)) throw new Error("sample bank refused");
    return out.length;
  }
}

// a whole render into one array per output channel
async function renderAll(state, r, opts) {
  const out = {}, offs = {};
  const res = await render(mod, state, r, {
    chunk: async (o, off, ch) => {
      if ((offs[o] ?? 0) !== off) throw new Error(`chunk of ${o} at ${off}, expected ${offs[o] ?? 0}`);
      offs[o] = off + ch[0].length;
      (out[o] ||= []).push(ch);
    },
    progress: () => {}, cancelled: () => false,
  }, opts);
  const cat = (parts, c) => { const n = parts.reduce((s, p) => s + p[c].length, 0), a = new Float32Array(n); let k = 0; for (const p of parts) { a.set(p[c], k); k += p[c].length; } return a; };
  return { res, out: Object.fromEntries(Object.entries(out).map(([o, p]) => [o, [cat(p, 0), cat(p, 1)]])) };
}
const pk = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.max(peak(v[0]), peak(v[1]))]));

// ---- the music the tests play, made as the page makes it
const fresh = await Dev.make();
const base = fresh.project();                          // a new FM1's project: DX7 303 PSG PLUCK SAMPLER DX7 303 808
const blankState = fresh.state();
// "groove": 16 steps on six tracks (T6, T7 muted as a new FM1 has them): DX7 chords, a 303 line, PSG, PLUCK, the
// sampler, the 808 (kick, snare, closed hat), reverb and delay sends on T1 and T3
const grooveProject = () => {
  const p = new Project(base.b).clear();
  for (let t = 0; t < 8; t++) p.length(t, 16);
  [0, 8].forEach((s) => p.note(0, s, 60, 100, 1));                                  // (chord 1: a major triad)
  [0, 3, 6, 10, 12, 14].forEach((s, i) => p.note(1, s, 36 + [0, 0, 7, 3, 0, 10][i]));
  [2, 6, 10, 14].forEach((s) => p.note(2, s, 72));
  [4, 12].forEach((s) => p.note(3, s, 67));
  [0, 7].forEach((s) => p.hit(4, s, 1 | 4));
  for (let s = 0; s < 16; s += 2) p.hit(7, s, (s % 8 === 0 ? 1 : 0) | (s % 8 === 4 ? 2 : 0) | 1024);
  return p.sends(0, 6, 4).sends(2, 0, 8).mute(96);
};
const groove = await (async () => (await Dev.make()).load(grooveProject()).state())();

// ---- determinism
for (const sr of [44100, 48000]) {
  const r = req({ outputs: ALL, sampleRate: sr, toBeat: 6, tailMs: 300 });
  const x = await renderAll(groove, r), y = await renderAll(groove, r);
  check(`${sr} Hz: two renders (mix + 7 stems), byte for byte the same (fresh instances)`,
        ALL.every((o) => same(x.out[o][0], y.out[o][0]) && same(x.out[o][1], y.out[o][1])) && peak(x.out.mix[0]) > 0.05);
}
{ // the mix alone is the mix of a render with stems (the capture leaves the mix as it is)
  const a = (await renderAll(groove, req({ toBeat: 6 }))).out.mix, b = (await renderAll(groove, req({ toBeat: 6, outputs: ALL }))).out.mix;
  check("the mix alone = the mix of a render with all stems, bit for bit", same(a[0], b[0]) && same(a[1], b[1]));
}

// ---- geometry (protocol 5): exact frame counts, all outputs one length, frame 0 = fromBeat
for (const [bpm, from, to, tail, sr] of [[120, 0, 8, 0, 44100], [123.45, 4, 13.5, 250, 44100], [123.45, 1, 9, 100, 48000], [97, 0, 4, 10000, 48000], [300, 0, 3, 0, 44100], [30, 2, 3, 0, 44100]]) {
  const r = req({ context: ctxOf(bpm), fromBeat: from, toBeat: to, tailMs: tail, sampleRate: sr, outputs: ALL });
  const want = Math.round((to * 60 / bpm) * sr) - Math.round((from * 60 / bpm) * sr) + Math.ceil(tail * sr / 1000);
  const { out } = await renderAll(groove, r);
  check(`${bpm} BPM [${from}, ${to}) + ${tail} ms at ${sr}: ${want} frames in each of ${ALL.length} outputs`, ALL.every((o) => out[o][0].length === want && out[o][1].length === want));
}
{ // a later start is the same audio as the frames of a render from 0 (every render plays from the start)
  const a = (await renderAll(groove, req({ context: ctxOf(123.45), fromBeat: 0, toBeat: 12, outputs: ["mix", "t2"] }))).out;
  const b = (await renderAll(groove, req({ context: ctxOf(123.45), fromBeat: 5.5, toBeat: 12, outputs: ["mix", "t2"] }))).out;
  const off = Math.round((5.5 * 60 / 123.45) * 44100);
  check(`[5.5, 12) at 123.45 BPM is [0, 12)'s frames from ${off} on, bit for bit (mix and a stem)`,
        same(a.mix[0].subarray(off, off + b.mix[0].length), b.mix[0]) && same(a.t2[1].subarray(off, off + b.t2[1].length), b.t2[1]));
}
{ // a tempo map with a change before the range: frame(beat) integrates it, the range at its own tempo
  const ctx = { timeMap: tm(100, [{ beat: 8, bpm: 140, ramp: "step" }]), key: null };
  const p = planRender(req({ context: ctx, fromBeat: 8, toBeat: 16 }));
  const f = (b) => frameAt(ctx.timeMap.tempoPoints, b, 44100);
  check(`a change at beat 8 (100 -> 140): [8, 16) is ${p.frames} = frame(16) - frame(8) frames at 140`,
        p.bpm === 140 && p.frames === f(16) - f(8) && f(8) === Math.round(8 * 60 / 100 * 44100));
  let code = null;
  try { planRender(req({ context: ctx, fromBeat: 4, toBeat: 12 })); } catch (e) { code = e.code; }
  const ap = planRender(req({ context: ctx, fromBeat: 4, toBeat: 12, approximation: "start-tempo" }));
  check("a change inside the range: 'unsupported'; with approximation 'start-tempo' at the tempo at fromBeat",
        code === "unsupported" && ap.bpm === 100 && ap.frames === Math.round(12 * 0.6 * 44100) - Math.round(4 * 0.6 * 44100));
  const ramp = { timeMap: tm(120, []), key: null };
  ramp.timeMap.tempoPoints = [{ beat: 0, bpm: 120, ramp: "linear" }, { beat: 4, bpm: 60, ramp: "step" }];
  const sec = frameAt(ramp.timeMap.tempoPoints, 4, 44100) / 44100, ideal = 60 * 4 / (60 - 120) * Math.log(60 / 120);
  check(`a linear ramp 120 -> 60 over 4 beats: ${sec.toFixed(4)} s (the integral: ${ideal.toFixed(4)} s)`, Math.abs(sec - ideal) < 1 / 44100);
  const ctx2 = { timeMap: tm(100, [{ beat: 3.3, bpm: 137.7, ramp: "step" }]), key: null };
  const p2 = planRender(req({ context: ctx2, fromBeat: 5, toBeat: 9.1, approximation: "start-tempo" }));
  const own = (b) => Math.round(b * 60 / 137.7 * 44100);
  check(`'start-tempo' lengths from the constant map at the start tempo: ${p2.frames} = own(9.1) - own(5)`, p2.frames === own(9.1) - own(5));
}
{ // the tempo range: FM1 Open's (30 .. 300 BPM), outside it 'unsupported', never a silently different tempo
  const code = (bpm, more) => { try { planRender(req({ context: ctxOf(bpm, more) })); return "ok"; } catch (e) { return e.code; } };
  const ex = await device(mod, null, 120);
  check(`tempo: ${MIN_BPM} and ${MAX_BPM} BPM render; 29.99, 300.01, 400 and 10 BPM: unsupported; the wasm's range the same`,
        code(30) === "ok" && code(300) === "ok" && code(29.99) === "unsupported" && code(300.01) === "unsupported" &&
        code(400) === "unsupported" && code(10) === "unsupported" && code(120, [{ beat: 16, bpm: 400, ramp: "step" }]) === "ok" &&
        ex.tutti_bpm_min() === MIN_BPM && ex.tutti_bpm_max() === MAX_BPM && ex.tutti_tempo(301) === 0 && ex.tutti_tempo(29) === 0 &&
        ex.tutti_tempo(123.45) === 1);
}
{ // progress (protocol 6, no seek): over the pre-roll from beat 0 and the range, monotonic, to 1
  const seen = [];
  let chunks = 0;
  await render(mod, groove, req({ fromBeat: 24, toBeat: 32 }), {
    chunk: async () => { chunks++; }, progress: (f) => seen.push([f, chunks]), cancelled: () => false });
  const before = Math.max(...seen.filter(([, c]) => c === 0).map(([f]) => f));
  check(`progress over pre-roll + range: ${seen.length} steps, ${before.toFixed(3)} (pre-roll 0.75) before the first chunk, then to 1`,
        seen.every(([f], i) => f >= 0 && f <= 1 && (!i || f >= seen[i - 1][0])) && before > 0.6 && before <= 0.75 &&
        seen.at(-1)[0] === 1 && seen.filter(([, c]) => c === 0).length > 3);
}

// ---- fractional tempo: the sequencer's clock (fm1_plugin.c tutti_ticks / tutti_phase) against the ideal grid, and
// the sound
if (!FAST) {
  const PERIOD = 44100 * 60;                           // clock units in a sixteenth (sequencer.c)
  const clock = async (bpm, nbars) => {                // the frame each bar starts at, from the clock, read at block starts
    const ex = await device(mod, groove, bpm);
    ex.tutti_start(0xFFFFFFFF);
    const BAR = 16 * PERIOD, got = [0];
    ex.tutti_render(1, 0);                             // (the transport starts with the first block: step 0 at frame 0)
    let f = BLOCK, u0 = ex.tutti_ticks() * PERIOD + ex.tutti_phase();
    while (got.length <= nbars) {
      ex.tutti_render(1, 0);
      const u1 = ex.tutti_ticks() * PERIOD + ex.tutti_phase(), k = got.length;
      if (u1 >= k * BAR) got.push(f + (k * BAR - u0) * BLOCK / (u1 - u0));   // (the bar line inside this block)
      u0 = u1;
      f += BLOCK;
    }
    return got;
  };
  const bpm = 123.45, got = await clock(bpm, 64);
  // (a render's clock starts half a block ahead, fm1_plugin.c tutti_start: its bar lines 64 frames before the ideal)
  const err = got.map((f, k) => f - (k ? (k * 4 * 60 / bpm) * 44100 - BLOCK / 2 : 0)), worst = Math.max(...err.map(Math.abs));
  check(`123.45 BPM: 64 bars' starts on the clock each within 0.01 sample of the ideal less half a block (worst ${worst.toFixed(5)}, bar 64 at ${got[64].toFixed(2)})`, worst < 0.01);
  // the sound: a kick on step 0 of a 16-step pattern; bar 64's against bar 0's. The engine takes steps at block starts
  // (blocks of 128 frames); a render's clock is half a block ahead, so a step takes the nearest one (within 64 frames)
  const p = new Project(base.b).clear().mute(0);
  for (let t = 0; t < 8; t++) p.length(t, 16);
  p.hit(7, 0, 1);
  const st = (await Dev.make()).load(p).state();
  const F64 = 64 * 4 * 60 / bpm * 44100;
  const { out } = await renderAll(st, req({ context: ctxOf(bpm), fromBeat: 255.5, toBeat: 256.5, outputs: ["mix"] }));
  const from = Math.round(255.5 * 60 / bpm * 44100), onset = from + out.mix[0].findIndex((x) => Math.abs(x) > 1e-4);
  const head = (await renderAll(st, req({ context: ctxOf(bpm), fromBeat: 0, toBeat: 0.5, outputs: ["mix"] }))).out.mix[0].findIndex((x) => Math.abs(x) > 1e-4);
  const late = onset - head - F64;
  check(`123.45 BPM: bar 64's kick at frame ${onset} (bar line ${F64.toFixed(2)}, bar 0's kick at ${head}): ${late.toFixed(2)} frames off, the nearest block start (within 64)`,
        Math.abs(late) <= BLOCK / 2 && head === 0);
}

// ---- stems
{
  const st = groove;
  const { out } = await renderAll(st, req({ outputs: ALL, toBeat: 8, tailMs: 500 }));
  const p = pk(out);
  check(`stems: T1..T5 and T8 sound (${["t1", "t2", "t3", "t4", "t5", "t8"].map((o) => p[o].toFixed(3)).join(" ")}), T6 + T7 (muted, empty) silent (${p.t67})`,
        ["t1", "t2", "t3", "t4", "t5", "t8"].every((o) => p[o] > 1e-3) && p.t67 === 0);
  const sumErr = [0, 1].map((c) => {
    const e = new Float32Array(out.mix[c].length);
    for (let i = 0; i < e.length; i++) { let s = out.mix[c][i]; for (const o of STEMS) s -= out[o][c][i]; e[i] = s; }
    return rms(e) / rms(out.mix[c]);
  });
  console.log(`plugin:   (mix - (t1 + .. + t5 + t67 + t8): ${db(sumErr[0])} / ${db(sumErr[1])} dB of the mix, L / R: the buses' saturation and gate, rounding)`);
  check("stems add up to the mix within -50 dB (README: best effort)", sumErr.every((x) => x < 10 ** (-50 / 20)));
  const solo = (await renderAll(st, req({ outputs: ["t3"], toBeat: 8, tailMs: 500 }))).out.t3;
  check("a stem rendered alone is the same as with the mix and the other stems", same(solo[0], out.t3[0]) && same(solo[1], out.t3[1]));
  // one track playing: its stem is the mix (the same products, the same buses, the same gains)
  const one = new Project(grooveProject().b).mute(255 & ~4);
  const o1 = (await renderAll((await Dev.make()).load(one).state(), req({ outputs: ["mix", "t3"], toBeat: 8, tailMs: 500 }))).out;
  const e1 = Math.max(...[0, 1].map((c) => rms(o1.mix[c].map((x, i) => x - o1.t3[c][i])) / rms(o1.mix[c])));
  check(`one track (T3, PSG with a delay send) playing: its stem = the mix (${e1 === 0 ? "bit for bit" : db(e1) + " dB"})`, e1 < 1e-6 && peak(o1.mix[0]) > 1e-3);
}

// ---- use A: the sequencer stops at toBeat, the tail only rings out; what Render to tuttidaw asks
{
  const a = (await renderAll(groove, req({ toBeat: 4, tailMs: 2000 }))).out.mix[0];
  const b = (await renderAll(groove, req({ toBeat: 12, tailMs: 0 }))).out.mix[0];
  const s = Math.round(4 * 0.5 * 44100) + 22050, e = s + 44100;       // 0.5 .. 1.5 s after toBeat
  const ta = peak(a.subarray(s, e)), tb = peak(b.subarray(s, e));
  check(`use A: after toBeat no new steps, the tail rings out (${ta.toFixed(4)} vs playing on ${tb.toFixed(3)})`,
        same(a.subarray(0, 88200 - 128), b.subarray(0, 88200 - 128)) && tb > 0.05 && ta < tb / 4);
  const steps = async (lens) => { const p = new Project(base.b).clear(); lens.forEach((l, t) => p.length(t, l)); return (await Dev.make()).load(p).ex.tutti_pattern_steps(); };
  const s1 = await steps([16, 16, 16, 16, 16, 16, 16, 16]), s2 = await steps([16, 32, 48, 16, 16, 16, 16, 64]), s3 = await steps([64, 64, 64, 64, 64, 64, 64, 64]);
  check(`the pattern's length (lengthBeats): 16 steps -> ${s1 / 4} beats, 16/32/48/64 -> ${s2 / 4} (until the loops meet), 64 -> ${s3 / 4}`,
        s1 === 16 && s2 === 192 && s3 === 64);
  const click = (await Dev.make()).load(new Project(grooveProject().b).metronome(2)).state();
  const c = (await renderAll(click, req({ toBeat: 8 }))).out.mix[0], n = (await renderAll(groove, req({ toBeat: 8 }))).out.mix[0];
  check("a project with the metronome always on: no click in a render", same(c, n));
}

// ---- use B: the host's MIDI on channels 0..7 (T1..T8 as PLAY tracks), the sequencer never runs
{
  const input = { notes: [{ beat: 1, lengthBeats: 1, pitch: 60, velocity: 100, channel: 0 }, { beat: 2.5, lengthBeats: 10, pitch: 67, velocity: 90, channel: 0 }],
                  cc: [{ beat: 0, channel: 0, cc: 1, value: 0 }], pitchBend: [{ beat: 0, channel: 0, value: 0 }], preRollBeats: 0 };
  const { out } = await renderAll(blankState, req({ input, toBeat: 4, tailMs: 200, outputs: ["mix", "t1", "t2"] }));
  const l = out.mix[0], at = l.findIndex((x) => Math.abs(x) > 1e-5), want = Math.round(1 * 0.5 * 44100);
  check(`use B: a note at beat 1 (frame ${want}) sounds at frame ${at}: the nearest block start, within 64 frames (latency compensated)`, Math.abs(at - want) <= 64);
  check("use B: before it silence, track 1's stem has it, track 2's nothing", peak(l.subarray(0, want - 64)) === 0 && peak(out.t1[0]) > 0.01 && peak(out.t2[0]) === 0);
  const held = (await renderAll(blankState, req({ input, toBeat: 3, tailMs: 0 }))).out.mix[0];
  const late = (await renderAll(blankState, req({ input, fromBeat: 2.75, toBeat: 3, tailMs: 0 }))).out.mix[0];
  check("use B: a note held over fromBeat sounds from its first frame (rendered from the start)",
        same(held.subarray(held.length - late.length), late) && peak(late.subarray(0, 64)) > 1e-3);
}
{ // each channel its track: 0..7 -> T1..T8 (T6, T7 muted in the project: unmuted as PLAY tracks), 8.. nothing
  const one = (channel, pitch) => ({ ...NOTHING, notes: [{ beat: 1, lengthBeats: 1, pitch, velocity: 110, channel }] });
  for (const [ch, pitch, want] of [[0, 60, "t1"], [1, 48, "t2"], [2, 67, "t3"], [3, 64, "t4"], [4, 36, "t5"], [5, 72, "t67"], [6, 40, "t67"], [7, 36, "t8"], [7, 38, "t8"], [9, 60, null], [15, 60, null]]) {
    const p = pk((await renderAll(groove, req({ input: one(ch, pitch), outputs: ALL, toBeat: 4, tailMs: 300 }))).out);
    const others = STEMS.filter((o) => o !== want).every((o) => p[o] === 0);
    check(`use B: channel ${ch} note ${pitch} -> ${want || "nothing"} only (${want ? p[want].toFixed(3) : p.mix})`, others && (want ? p[want] > 0.003 && p.mix > 0.003 : p.mix === 0));
  }
  // the state has a pattern: with input, none of it plays (protocol 7b)
  const a = pk((await renderAll(groove, req({ input: null, outputs: ALL, toBeat: 8 }))).out);
  const b = pk((await renderAll(groove, req({ input: NOTHING, outputs: ALL, toBeat: 8, tailMs: 500 }))).out);
  check(`use B: the state's pattern (use A peak ${a.mix.toFixed(3)}) does not play: no notes -> every output silent`, a.mix > 0.05 && ALL.every((k) => b[k] === 0));
  const vel = async (v, ch, pitch) => peak((await renderAll(blankState, req({ input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: 1, pitch, velocity: v, channel: ch }] }, outputs: [`t${ch + 1}`], toBeat: 2 }))).out[`t${ch + 1}`][0]);
  const [s1, l1, s2, l2] = [await vel(20, 0, 60), await vel(127, 0, 60), await vel(20, 7, 38), await vel(127, 7, 38)];
  check(`use B: velocity (T1 DX7 at 20: ${s1.toFixed(3)}, at 127: ${l1.toFixed(3)}; the 808's snare at 20: ${s2.toFixed(3)}, at 127: ${l2.toFixed(3)})`,
        s1 < l1 * 0.8 && s2 < l2 * 0.8 && s1 > 0 && s2 > 0);
}
{ // zero-length notes (protocol 7b): the off after the on, never before; a note that rounds to no frames too
  const n = (beat, lengthBeats, pitch = 60) => ({ beat, lengthBeats, pitch, velocity: 100, channel: 0 });
  const ev = midiEvents({ notes: [n(0, 1), n(1, 0), n(2, 1e-9), n(3, -0)], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8);
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  const kinds = ev.map((e) => `${e.status >> 4 === 9 ? "on" : "off"}@${e.frame}`);
  const want = [`on@0`, `off@${at(1)}`, `on@${at(1)}`, `off@${at(1) + 128}`, `on@${at(2)}`, `off@${at(2) + 128}`, `on@${at(3)}`, `off@${at(3) + 128}`];
  check(`zero-length notes: each off a block after its on (${kinds.slice(1, 4).join(" ")})`, kinds.join() === want.join());
  const o = (await renderAll(blankState, req({ input: { ...NOTHING, notes: [n(1, 0)] }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const hold = (await renderAll(blankState, req({ input: { ...NOTHING, notes: [n(1, 8)] }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const end = (x) => peak(x.subarray(x.length - 44100));
  check(`zero-length notes: the note sounds (peak ${peak(o).toFixed(3)}) and is let go (the last second ${end(o).toFixed(4)}, held ${end(hold).toFixed(4)})`,
        peak(o) > 1e-3 && end(o) < end(hold) / 4);
  let k;
  try {
    k = midiEvents({ notes: [{ beat: 1, lengthBeats: -0.75, pitch: 60, velocity: 100, channel: 0 }], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8)
      .map((e) => `${e.status >> 4 === 9 ? "on" : "off"}@${e.frame}`).join(" ");
  } catch (err) { k = `${err.code}`; }
  check(`a note of length -0.75 (protocol 7b: <= 0): accepted as zero-length, its on then its off (${k})`, k === `on@${at(1)} off@${at(1) + 128}`);
}
{ // the sustain pedal down over toBeat (its pedal-up past it) lets go at toBeat: nothing held into the tail
  const n = (beat, lengthBeats) => ({ beat, lengthBeats, pitch: 60, velocity: 100, channel: 0 });
  const ped = (beat, value) => ({ beat, channel: 0, cc: 64, value });
  const inp = (cc) => ({ notes: [n(1, 10)], cc, pitchBend: [], preRollBeats: 0 });
  const end = Math.round(4 * 0.5 * 44100);
  const k = midiEvents(inp([ped(0.5, 127), ped(6, 0)]), 120, 4).map((e) => `${e.status.toString(16)}:${e.d1}:${e.d2}@${e.frame}`);
  check(`sustain: the pedal up at toBeat, before the note's off there (${k.slice(-2).join(" ")})`,
        k.slice(-2).join() === [`b0:64:0@${end}`, `80:60:0@${end}`].join());
  const one = async (cc) => (await renderAll(blankState, req({ input: inp(cc), toBeat: 4, tailMs: 3000, outputs: ["t1"] }))).out.t1[0];
  const free = await one([]), held = await one([ped(0.5, 127), ped(6, 0)]);
  const tail = (x) => rms(x.subarray(end + 44100));
  check(`sustain: the tail past toBeat as without the pedal (rms ${tail(held).toExponential(2)}, no pedal ${tail(free).toExponential(2)})`,
        rms(free.subarray(end - 22050, end)) > 1e-3 && tail(held) <= tail(free) * 1.05 + 1e-6);
}
{ // use B with the arpeggiator's HOLD saved (T2 303, T3 PSG): the host's note-offs let the notes go all the same (a
  // runtime override, the state keeps HOLD on), at toBeat nothing is held: past the notes' ends only a decaying tail,
  // the arp stopped; the same render as without HOLD
  const make = async (hold) => {
    const p = new Project(base.b).clear().arp(1, { hold }).arp(2, { hold, mode: 2 });
    const d = (await Dev.make()).load(p);
    const arp = (t) => d.ex.sim_arp(t);
    return { st: d.state(), hold: [1, 2].map((t) => (arp(t) >> 23) & 1), on: [1, 2].map((t) => (arp(t) >> 8) & 1) };
  };
  const held = await make(1), free = await make(0);
  const n = (beat, lengthBeats, pitch, channel) => ({ beat, lengthBeats, pitch, velocity: 110, channel });
  const inp = { notes: [n(0, 1, 48, 1), n(0, 1, 52, 1), n(0, 1, 72, 2), n(0, 1, 76, 2), n(2.5, 4, 50, 1), n(2.5, 4, 79, 2)], cc: [], pitchBend: [], preRollBeats: 0 };
  const r = req({ input: inp, toBeat: 4, tailMs: 4000, outputs: ["mix", "t2", "t3"] });
  const a = (await renderAll(held.st, r)).out, b = (await renderAll(free.st, r)).out;
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  const W = 11025, prof = (x, from) => Array.from({ length: 12 }, (_, i) => rms(x.subarray(from + i * W, from + (i + 1) * W)));
  const decays = (x, from) => { const v = prof(x, from); return v.every((y, i) => !i || y <= v[i - 1] * 1.5 + 1e-6) && v[11] < v[0] / 30 + 1e-7; };
  const gap = rms(a.t2[0].subarray(at(1.6), at(2.5))), first = rms(a.t2[0].subarray(at(0), at(1)));
  const end = rms(a.mix[0].subarray(a.mix[0].length - 22050)), body = rms(a.mix[0].subarray(0, at(1)));
  check(`use B + ARP HOLD saved (hold ${held.hold.join(",")}, arp on ${held.on.join(",")}): after each note's end only a decaying tail, the arp stopped`,
        held.hold.join() === "1,1" && held.on.join() === "1,1" && decays(a.t2[0], at(4)) && decays(a.t3[0], at(4)) && gap < first / 10 && body > 1e-3 && end < body / 100);
  check("use B + ARP HOLD: the same render as without HOLD (the host's note lifetimes), the state's HOLD unchanged",
        ["mix", "t2", "t3"].every((o) => same(a[o][0], b[o][0]) && same(a[o][1], b[o][1])) && free.hold.join() === "0,0");
}

// ---- the host's tempo is a runtime value: not the project's tempo, not in the state's signature
{
  const d = await Dev.make(groove);
  d.run(200);
  const sig0 = d.ex.tutti_sig(), tempo0 = d.project().dv.getUint16(TEMPO, true);
  d.ex.tutti_tempo(97.3);
  d.run(300);
  d.ex.tutti_tempo(181.25);
  d.run(300);
  check(`host tempo: the project's tempo stays its own (${tempo0} -> ${d.project().dv.getUint16(TEMPO, true)}), the state's signature unchanged`,
        d.project().dv.getUint16(TEMPO, true) === tempo0 && d.ex.tutti_sig() === sig0);
  d.ex.sim_step(3, 1);                                 // (an edit: a step toggled, as the panel does)
  check("an edit (a step toggled on the panel): the state's signature changes", d.ex.tutti_sig() !== sig0);
}

// ---- the clock: a state saved with the external MIDI clock plays at the host's tempo, hosted and in a render; the
// saved setting stays the user's
{
  const d = await Dev.make(groove);
  d.ex.sim_midi_edit(0, 6, 1);                         // (MIDI ROUTING: a clock source: the clock goes external, saved)
  d.run(1700);                                         // (the settings are written 1.5 s after the last change)
  const ext = d.state();
  const viewClock = (ex) => new Uint8Array(ex.memory.buffer, ex.sim_state(), 225)[8 + 8];
  const alone = await Dev.make(ext), hostedDev = await Dev.make(ext, { hosted: true });
  check(`a state saved with the MIDI clock: by itself the clock is external (${viewClock(alone.ex)}); hosted, internal (${viewClock(hostedDev.ex)})`,
        viewClock(alone.ex) === 1 && viewClock(hostedDev.ex) === 0);
  hostedDev.ex.tutti_tempo(120);
  hostedDev.ex.tutti_live_play(0);
  hostedDev.run(500);
  const pos = hostedDev.ex.tutti_live_pos();
  check(`hosted preview of it: plays at the host's tempo (half a second: ${pos.toFixed(2)} sixteenths of 4)`, Math.abs(pos - 4) < 0.1);
  const a = (await renderAll(ext, req({ toBeat: 8 }))).out.mix[0];
  const b = (await renderAll(groove, req({ toBeat: 8 }))).out.mix[0];
  const back = await Dev.make(unpackState(packState(hostedDev.state())));
  check(`a render of it plays at the host's tempo (peak ${peak(a).toFixed(3)}), as the same state with the internal clock; the state keeps MIDI (${viewClock(back.ex)})`,
        peak(a) > 0.05 && same(a, b) && viewClock(back.ex) === 1);
}

// ---- the preview's place: tutti_live_play puts the sequencer where the host is, at once (no catching up)
{
  const d = await Dev.make((await Dev.make()).load(grooveProject().swing(30)).state(), { hosted: true });
  d.ex.tutti_tempo(123.45);
  const at = [];
  for (const s of [0, 1, 7.5, 64 * 16 + 3.25, 10001.75]) { d.ex.tutti_live_play(s); at.push([s, d.ex.tutti_live_pos()]); }
  check(`preview: placed at ${at.map(([s, p]) => `${s} -> ${p.toFixed(3)}`).join(", ")} sixteenths (with swing 30)`, at.every(([s, p]) => Math.abs(s - p) < 1e-6));
  const arm = await Dev.make((await Dev.make()).load(new Project(base.b).clear().note(0, 0, 60).note(0, 4, 60).mute(0)).state(), { hosted: true });
  arm.ex.tutti_tempo(120);
  const heard = (s) => { arm.ex.tutti_live_play(s); let p = 0; for (let k = 0; k < 40; k++) { const o = new Float32Array(arm.ex.memory.buffer, arm.ex.sim_render(), 256); for (const x of o) p = Math.max(p, Math.abs(x)); } arm.ex.tutti_live_stop(); for (let k = 0; k < 400; k++) arm.ex.sim_render(); return p; };
  const p0 = heard(0), pIn = heard(0.0001), pLate = heard(0.5);
  check(`preview: placed on a step (0, or just past it) the step sounds (${p0.toFixed(3)}, ${pIn.toFixed(3)}); placed mid-step it does not (${pLate.toFixed(4)})`,
        p0 > 0.01 && pIn > 0.01 && pLate < p0 / 20);
  d.ex.tutti_live_play(32);
  d.run(1000);
  const pos = d.ex.tutti_live_pos(), want = 32 + 123.45 / 60 * 4;
  d.ex.tutti_live_stop();
  d.run(50);
  check(`preview: from 32 sixteenths, a second later at ${pos.toFixed(2)} (${want.toFixed(2)}, within a block); stopped: not playing`,
        Math.abs(pos - want) < 0.05 && d.ex.tutti_playing() === 0);
}

// ---- 48 kHz: the resampler against a sine
if (!FAST) {
  const f = 1000, n = 44100, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = r[i] = 0.5 * Math.sin(2 * Math.PI * f * i / 44100);
  const rs = new Resampler(0), ol = new Float64Array(48000), or = new Float64Array(48000);
  rs.push(l, r);
  const k = rs.take(ol, or, 0, 48000);
  let e = 0, c = 0;
  for (let i = 2000; i < k - 2000; i++) { const d = ol[i] - 0.5 * Math.sin(2 * Math.PI * f * i / 48000); e += d * d; c++; }
  const err = Math.sqrt(e / c) / (0.5 / Math.SQRT2);
  check(`48 kHz: a 1 kHz sine resampled, error ${db(err)} dB (under -90), on time (no delay)`, err < 10 ** (-90 / 20));
}

// ---- the state: everything a user makes, packed, unpacked, into a fresh FM1, the same; a render of it the same
{
  const d = await Dev.make();
  const p = grooveProject().tuning(0, [0, 0, 0, 0, -14, 0, 0, 0, 0, 0, 0, 0, ...Array(12).fill(25)]);
  d.load(p);
  d.ex.sim_select(4, 6);                               // (T5, the sampler: its slot 1 gets the user sample)
  const pcm = Int16Array.from({ length: 9000 }, (_, i) => Math.round(12000 * Math.sin(i / 5) * Math.exp(-i / 3000)));
  const bankBytes = d.sample(0, pcm, "USER BLIP");
  const lib = (() => { d.ex.sim_library_read(1); const b = new Uint8Array(d.ex.memory.buffer, d.ex.sim_file(), 4096).slice(); b[0] ^= 1; d.file(b); return d.ex.sim_library_write(1); })();
  d.ex.sim_midi_edit(2, 1, 3);                         // (MIDI: a track's output channel, a device setting)
  d.run(1700);
  d.ex.sim_step(5, 1);                                 // (an edit not saved to a slot: in the state's project)
  const s = d.state();
  const buf = packState(s), back = unpackState(buf);
  check(`state: ${buf.byteLength} B (${Object.keys(s.sectors).length} sectors, a user sample of ${bankBytes} B in the bank, a DX7 bank written: ${lib === 0}), unpacked the same, the input unchanged`,
        stateEquals(buf, packState(back)) && same(back.project, s.project) && Object.keys(s.sectors).every((k) => same(s.sectors[k], back.sectors[k])) && lib === 0);
  let bad = 0;
  for (const b of [new ArrayBuffer(3), new Uint8Array(20).buffer, buf.slice(0, buf.byteLength - 1)])
    try { unpackState(b); } catch (e) { if (e.code === "state-incompatible") bad++; }
  try { unpackState(buf, 3); } catch (e) { if (e.code === "state-incompatible") bad++; }
  check("state: short, foreign, truncated and other-version states refused (state-incompatible)", bad === 4);
  const f2 = await Dev.make(back), s2 = f2.state();
  const flashSame = (() => { const a = d.flash(), b = f2.flash(); return a.every((x, i) => x === b[i]); })();
  const tuningOf = (pr) => Array.from(new Int8Array(pr.buffer, pr.byteOffset + 4068, 24));
  check(`state round trip into a fresh FM1: the project (tuning ${tuningOf(s2.project).slice(4, 5)} / ${tuningOf(s2.project)[12]} cents), the whole flash (slots, settings, samples, DX7 library) the same`,
        same(s2.project, s.project) && flashSame && tuningOf(s2.project)[4] === -14 && tuningOf(s2.project)[12] === 25);
  const r = req({ outputs: ALL, toBeat: 8, tailMs: 300 });
  const x = await renderAll(s, r), y = await renderAll(s2, r);
  check("state round trip: the fresh FM1's state renders the same bytes", ALL.every((o) => same(x.out[o][0], y.out[o][0]) && same(x.out[o][1], y.out[o][1])));
  const smp = (st) => renderAll(st, req({ input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: 1, pitch: 36, velocity: 120, channel: 4 }] }, outputs: ["t5"], toBeat: 2 }));
  const withUser = (await smp(s)).out.t5[0], withDemo = (await smp(groove)).out.t5[0];
  check(`the user sample plays from the state (T5 slot 1: peak ${peak(withUser).toFixed(3)}, the demo bank's ${peak(withDemo).toFixed(3)}, not the same)`,
        peak(withUser) > 0.01 && !same(withUser, withDemo));
  const tuned = (st) => renderAll(st, req({ input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: 1, pitch: 64, velocity: 110, channel: 0 }] }, outputs: ["t1"], toBeat: 2 }));
  check("the tuning plays from the state (T1's E 14 cents flat: not the 12-TET note)", !same((await tuned(s)).out.t1[0], (await tuned(groove)).out.t1[0]));
}

// ---- PLAY tracks as they play are in the state (the live session, state.js version 2): a PLAY track's timbre, its
// arpeggiator, its tuning (what the exported project leaves out: it has the dormant arrangement rows) come back in a
// fresh FM1 and a use-B render sounds them; version 1 states still read
const timbreEdit = (d) => {                            // (the selected track's timbre, as the page's timbre import: another algorithm)
  if (d.ex.sim_timbre_export()) throw new Error("timbre export");
  const t = new Uint8Array(d.ex.memory.buffer, d.ex.sim_file(), 223).slice();
  t[11 + 134] = (t[11 + 134] + 7) % 32;
  t[11 + 135] = 7;
  d.file(t);
  return d.ex.sim_timbre_import();
};
const playOn = (d, t = 0) => d.ex.tutti_track_setting(t, 0, 1);   // (the track settings page: role NORMAL -> PLAY)
const roleOf = (d, t) => { d.ex.tutti_session_capture(); return new Uint8Array(d.ex.memory.buffer, d.ex.tutti_session(), 4272)[4256 + t]; };
const useB = (st, pitch = 60, beats = 1) => renderAll(st, req({ input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: beats, pitch, velocity: 110, channel: 0 }] }, outputs: ["t1"], toBeat: 2 }));
// a version 1 state (no session): what the plugin wrote before
const packV1 = (st) => {
  const v2 = new Uint8Array(packState({ ...st, session: null })), dv = new DataView(v2.buffer), ml = dv.getUint32(8, true), s0 = 12 + ml + 4 + PROJECT_BYTES;
  const v1 = new Uint8Array(v2.length - 4);
  v1.set(v2.subarray(0, s0));
  v1.set(v2.subarray(s0 + 4), s0);
  new DataView(v1.buffer).setUint32(4, 1, true);
  return v1.buffer;
};
{
  const d = await Dev.make();
  d.run(200);
  const sig0 = d.ex.tutti_sig();
  playOn(d);
  const sig1 = d.ex.tutti_sig(), played = d.state();
  const ti = timbreEdit(d);
  const sig2 = d.ex.tutti_sig(), edited = d.state();
  check(`a PLAY track's timbre edited (import ${ti}): the exported project the same (its dormant row), the state's signature changes (role ${sig0 !== sig1}, timbre ${sig1 !== sig2})`,
        ti === 0 && roleOf(d, 0) === 1 && same(played.project, edited.project) && sig0 !== sig1 && sig1 !== sig2);
  const back = await Dev.make(unpackState(packState(edited)));
  back.run(2500);                                      // (past the settings' own restore and write)
  const tOf = (x) => { x.ex.sim_timbre_export(); return new Uint8Array(x.ex.memory.buffer, x.ex.sim_file(), 223).slice(); };
  check("a fresh FM1 from that state: T1 still PLAY, its timbre the edited one (the role not yet written to the flash: from the session)",
        roleOf(back, 0) === 1 && same(tOf(back), tOf(d)));
  const a = (await useB(played)).out.t1[0], b = (await useB(edited)).out.t1[0], c = (await useB({ ...edited, session: null })).out.t1[0];
  check(`use B on channel 0 sounds the edited timbre (peak ${peak(b).toFixed(3)}; the default's ${peak(a).toFixed(3)}: not the same; without the session: the default's)`,
        peak(b) > 0.01 && !same(a, b) && same(a, c));
  // the arpeggiator: T1 PLAY with its arpeggiator on, then a project without one loaded (the dormant row: off), a rate edited
  const e = await Dev.make();
  e.load(new Project(base.b).clear().arp(0, { on: 1, rate: 2 }));
  playOn(e);
  e.load(new Project(base.b).clear());
  const s0 = e.ex.tutti_sig();
  e.ex.tutti_arp_edit(0, 0, 1);
  const arpSt = e.state(), s1 = e.ex.tutti_sig(), arpBack = await Dev.make(unpackState(packState(arpSt)));
  const on = (await useB(arpSt, 60, 2)).out.t1[0], plain = (await useB({ ...arpSt, session: null }, 60, 2)).out.t1[0];
  check(`a PLAY track's arpeggiator (on, rate edited: signature changes ${s0 !== s1}) back in a fresh FM1 (${(arpBack.ex.sim_arp(0) >> 8).toString(2)} = ${(e.ex.sim_arp(0) >> 8).toString(2)}), its use-B render arpeggiated, not the dormant row's`,
        s0 !== s1 && (e.ex.sim_arp(0) >> 8) & 1 && arpBack.ex.sim_arp(0) >> 8 === e.ex.sim_arp(0) >> 8 && !same(on, plain) && peak(on) > 0.01);
  // the tuning: T1 PLAY tuned, then a project without tuning loaded (the dormant row: 12-TET)
  const f = await Dev.make();
  f.load(grooveProject().tuning(0, [0, 0, 0, 0, -40, 0, 0, 0, 0, 0, 0, 0, ...Array(12).fill(0)]));
  playOn(f);
  const t0 = f.ex.tutti_sig();
  f.load(grooveProject());
  const tuneSt = f.state();
  const tuned = (await useB(tuneSt, 64)).out.t1[0], flat = (await useB(groove, 64)).out.t1[0], lost = (await useB({ ...tuneSt, session: null }, 64)).out.t1[0];
  const dormantTet = new Int8Array(tuneSt.project.buffer, tuneSt.project.byteOffset + 4068, 24)[4] === 0;
  check(`a PLAY track's tuning (E 40 cents flat) in the state though the project's row is 12-TET (${dormantTet}): its use-B render tuned, without the session not`,
        dormantTet && t0 !== f.ex.tutti_sig() && !same(tuned, flat) && same(lost, flat));
  // version 1
  const v1 = packV1(edited), u1 = unpackState(v1, 1);
  const fromV1 = await Dev.make(u1);
  check("a version 1 state (no session) reads: the project and the flash as they were, no session",
        u1.session === null && same(u1.project, edited.project) && Object.keys(edited.sectors).every((k) => same(u1.sectors[k], edited.sectors[k])) && !!fromV1);
}

// ================================================================== the protocol (a fake host)
// a live device as the page has it (tutti.js live): the wasm not headless, its edits checked by tutti_sig
class NodeLive {
  constructor() {
    this.dev = null; this.loads = 0; this.transports = []; this.tempos = [];
    this.tempo = new PreviewTempo((bpm) => { this.tempos.push(bpm); this.dev.ex.tutti_tempo(bpm); });   // (as the page's)
  }
  async load(state, context) {
    this.dev = await Dev.make(state, { hosted: true });
    this.dev.run(200);
    this.sig = this.dev.ex.tutti_sig();
    this.loads++;
    this.tempo.reset();
    this.context(context);
  }
  edit(fn) {                                          // a user's edit, then the page's check
    fn(this.dev);
    this.dev.run(50);
    const s = this.dev.ex.tutti_sig();
    if (s !== this.sig) { this.sig = s; this.engine.changed(); }
  }
  async snapshot() {
    const s = this.dev.state();
    this.sig = this.dev.ex.tutti_sig();
    return s;
  }
  context(ctx) { this.tempo.context(ctx); }
  transport(t) { this.transports.push(t); }
  close() { this.closed = true; }
}
const blank = async () => (await Dev.make()).state();
const checkState = async (st) => { await Dev.make(st); };   // (as the page's: the project must load)
const HOST = "https://tuttidaw.com";
function harness({ live = null, chunkFrames } = {}) {
  const hello = [];
  const engine = new FM1Engine({
    render: (state, r, sink) => render(mod, state, r, sink, chunkFrames ? { chunkFrames } : {}),
    blank, check: checkState, live, onChanged: (rev) => session.stateChanged(rev),
  });
  if (live) live.engine = engine;
  const session = new PluginSession({ engine, post: (m) => hello.push(m), plugin: { id: "com.weavejam.fm1open", version: "t", build: "t" } });
  const h = { session, engine, hello, got: [], waiters: [] };
  h.connect = (o = {}) => {
    const ch = new MessageChannel();
    h.port = ch.port1;
    h.port.onmessage = (e) => {
      h.got.push(e.data);
      for (const w of [...h.waiters]) if (w.pred(e.data)) { h.waiters.splice(h.waiters.indexOf(w), 1); w.res(e.data); }
    };
    h.sid = o.sessionId || "s-" + Math.random().toString(36).slice(2);
    return session.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL, sessionId: h.sid, generation: o.generation ?? 1,
                                             host: { name: "test", version: "0", timeOrigin: 0 } },
                                     origin: o.origin ?? HOST, isParent: o.isParent ?? true, ports: [ch.port2] });
  };
  h.send = (m, transfer) => h.port.postMessage({ sessionId: h.sid, ...m }, transfer || []);
  h.wait = (pred, ms = 60000) => new Promise((res, rej) => {
    const old = h.got.find(pred);
    if (old) { h.got.splice(h.got.indexOf(old), 1); return res(old); }
    const w = { pred, res: (m) => { clearTimeout(t); h.got.splice(h.got.indexOf(m), 1); res(m); } };
    const t = setTimeout(() => { h.waiters.splice(h.waiters.indexOf(w), 1); rej(new Error("timeout waiting")); }, ms);
    h.waiters.push(w);
  });
  h.reply = (id) => h.wait((m) => m.id === id && (m.type.endsWith(":ok") || m.type === "error"));
  h.terminals = (id) => h.got.filter((m) => m.id === id && (m.type.endsWith(":ok") || m.type === "error")).length;
  h.chunks = (id) => h.got.filter((m) => m.type === "render-chunk" && m.renderId === id).length;
  h.close = () => { try { h.port.close(); } catch {} };
  return h;
}
const collect = (h, renderId) => {                    // the chunks of a render, granting a credit per chunk taken
  const chunks = [];
  const on = h.port.onmessage;
  h.port.onmessage = (e) => {
    if (e.data.type === "render-chunk" && e.data.renderId === renderId) {
      chunks.push(e.data);
      h.send({ type: "render-credit", renderId, chunks: 1 });
    } else on(e);
  };
  return chunks;
};
// nothing more comes: the session idle (no render running, or this one waiting for credits) for a while
const settled = async (h, id) => {
  let n = -1;
  while (n !== h.got.length) { n = h.got.length; await sleep(200); }
  return h.chunks(id);
};

// ---- handshake
{
  const h = harness();
  h.session.hello();
  check("hello: {type, protocol} to the parent, nothing else", h.hello.length === 1 && h.hello[0].type === "tutti-plugin:hello" &&
        h.hello[0].protocol === PROTOCOL && Object.keys(h.hello[0]).length === 2);
  const prod = (o) => embedderAllowed(o, CHANNELS.production), prev = (o) => embedderAllowed(o, CHANNELS.preview);
  const never = ["https://pr-12.tuttidaw.com", "http://tuttidaw.com", "https://tuttidaw.com.evil.io", "https://eviltuttidaw.com",
                 "https://a.b.tuttidaw.com", "https://www.tuttidaw.com:8443", "https://TUTTIDAW.com", "https://localhost:3000",
                 "http://127.0.0.1:5173", "http://localhost.evil.io", "http://localhost:5173/", "null", "", undefined];
  check("embedders, production: exactly https://tuttidaw.com and https://www.tuttidaw.com (the default)",
        ["https://tuttidaw.com", "https://www.tuttidaw.com"].every(prod) && !["http://localhost:5173", "http://localhost", ...never].some(prod) &&
        embedderAllowed("https://www.tuttidaw.com") && !embedderAllowed("http://localhost:5173"));
  check("embedders, preview: those and http://localhost:<any port>; not others",
        ["https://tuttidaw.com", "https://www.tuttidaw.com", "http://localhost:5173", "http://localhost"].every(prev) && !never.some(prev));
  check("connect from a wrong origin ignored", h.connect({ origin: "https://evil.example" }) === 0);
  check("connect from another window (not the parent) ignored", h.connect({ isParent: false }) === 0);
  check("connect from the parent at tuttidaw.com accepted", h.connect() === 1);
  const first = h.sid;
  const h2port = h.port;
  check("a second connect ignored while the session lives", h.connect({ sessionId: "other" }) === 0);
  h.port = h2port; h.sid = first;
  h.send({ type: "get-state", id: "g0" });
  const g0 = await h.reply("g0");
  check("get-state before init: error bad-request", g0.type === "error" && g0.code === "bad-request" && g0.fatal === false);
  h.port.postMessage({ type: "init", sessionId: "wrong", id: "x", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  h.send({ type: "init", id: "i1", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  const i1 = await h.reply("i1");
  check("a message of another session dropped (no reply; the next one of this session answered)", !h.got.some((m) => m.id === "x"));
  check("init (null state, mode render, no gesture, no audio): init:ok {plugin, stateRevision}",
        i1.type === "init:ok" && i1.plugin.id === "com.weavejam.fm1open" && i1.stateRevision === 1 && i1.sessionId === first);
  h.send({ type: "init", id: "i2", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  check("init twice: bad-request", (await h.reply("i2")).code === "bad-request");
  h.send({ type: "bogus" });
  h.send({ type: "render", id: "rb" });
  const rb = await h.reply("rb");
  h.port.postMessage("not an object");
  h.send({ type: "render" });
  const noid = await h.wait((m) => m.type === "error" && m.id === undefined);
  check("unknown types and invalid messages: dropped or bad-request, the session goes on", rb.code === "bad-request" && noid.code === "bad-request");
  h.send({ type: "render", id: "big", ...req({ renderId: "big", toBeat: 2000, context: ctxOf(60) }) });
  check("a render over 600 s: too-large", (await h.reply("big")).code === "too-large");
  h.send({ type: "render", id: "sr", ...req({ renderId: "sr", sampleRate: 96000 }) });
  check("a render at 96 kHz: unsupported", (await h.reply("sr")).code === "unsupported");
  h.send({ type: "render", id: "tc", ...req({ renderId: "tc", context: ctxOf(120, [{ beat: 4, bpm: 90, ramp: "step" }]) }) });
  check("a tempo change in the range (tempoMap constant): unsupported", (await h.reply("tc")).code === "unsupported");
  h.send({ type: "render", id: "rv", ...req({ renderId: "rv", stateRevision: 7 }) });
  check("a render of an unknown state revision: state-incompatible", (await h.reply("rv")).code === "state-incompatible");
  h.send({ type: "get-state", id: "gn" });
  const gn = await h.reply("gn");
  check(`get-state of a session inited without a state: a new FM1's state (${gn.state.byteLength} B, revision ${gn.stateRevision})`,
        gn.type === "get-state:ok" && gn.stateRevision === 1 && unpackState(gn.state).project.length === PROJECT_BYTES);
  h.send({ type: "close" });
  await until(() => h.session.state === "closed");
  check("close: the session ends; a new connect (a reload) is a new session", h.session.state === "closed" && h.connect({ generation: 2 }) === 1);
  h.send({ type: "init", id: "i3", sampleRate: 44100, context: ctxOf(120), state: packState(groove), stateVersion: STATE_VERSION, mode: "render" });
  check("init with a saved state in the new session: init:ok", (await h.reply("i3")).type === "init:ok");
  const h3 = harness();
  h3.connect();
  h3.send({ type: "init", id: "i5", sampleRate: 44100, context: ctxOf(120), state: new ArrayBuffer(16), stateVersion: 1, mode: "render" });
  const i5 = await h3.reply("i5");
  const h4 = harness();
  h4.connect();
  h4.send({ type: "init", id: "i6", sampleRate: 44100, context: ctxOf(120), state: packState(groove), stateVersion: 9, mode: "render" });
  const i6 = await h4.reply("i6");
  const broken = { ...groove, project: groove.project.slice() };
  broken.project[4260] ^= 0xFF;                        // (the tuning tail's CRC: sim_import refuses the project)
  const h5 = harness();
  h5.connect();
  h5.send({ type: "init", id: "i7", sampleRate: 44100, context: ctxOf(120), state: packState(broken), stateVersion: STATE_VERSION, mode: "edit" });
  const i7 = await h5.reply("i7");
  h5.close();
  check(`init with a foreign state, an unread version, a project the device cannot load: state-incompatible (${i5.code} ${i6.code} ${i7.code})`,
        i5.code === "state-incompatible" && i6.code === "state-incompatible" && i7.code === "state-incompatible");
  h.close(); h3.close(); h4.close();
}

// ---- renders through the session: chunks, lengths, credits, cancel, busy, determinism
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(123.45), state: packState(groove), stateVersion: STATE_VERSION, mode: "render" });
  const rev = (await h.reply("i")).stateRevision;
  h.send({ type: "render", id: "c1", ...req({ renderId: "c1", stateRevision: rev, context: ctxOf(123.45), toBeat: 40, outputs: ALL }) });
  await until(() => h.chunks("c1") >= INITIAL_CREDITS);
  const inFlight = await settled(h, "c1");
  check(`credits: ${inFlight} chunks out with the ${INITIAL_CREDITS} initial credits, then it waits`, inFlight === INITIAL_CREDITS && h.terminals("c1") === 0);
  h.send({ type: "render", id: "c2", ...req({ renderId: "c2", stateRevision: rev }) });
  const busy = await h.reply("c2");
  check("a second render while one runs: busy", busy.code === "busy" && busy.renderId === "c2");
  h.send({ type: "render-credit", renderId: "c1", chunks: 3 });
  await until(() => h.chunks("c1") >= inFlight + 3);
  const after = await settled(h, "c1");
  check(`credits: 3 more granted, ${after - inFlight} more chunks`, after === inFlight + 3);
  h.send({ type: "cancel", renderId: "c1" });
  const term = await h.reply("c1");
  h.send({ type: "get-state", id: "gx" });
  await h.reply("gx");
  check("cancel mid-render: exactly one terminal, error cancelled", term.code === "cancelled" && h.terminals("c1") === 0);
  const run = async (id, extra = {}) => {
    const chunks = collect(h, id);
    h.send({ type: "render", id, ...req({ renderId: id, stateRevision: rev, context: ctxOf(123.45), fromBeat: 2, toBeat: 18, tailMs: 750, outputs: ALL, ...extra }) });
    const ok = await h.reply(id);
    return { ok, chunks };
  };
  const a = await run("w1"), b = await run("w2");
  const want = Math.round(18 * 60 / 123.45 * 44100) - Math.round(2 * 60 / 123.45 * 44100) + Math.ceil(0.75 * 44100);
  const len = (cs, o) => cs.filter((c) => c.output === o).reduce((s, c) => s + c.channels[0].length, 0);
  check(`render via the session: render:ok, each output ${want} frames, chunks <= 1 s, offsets in order`,
        a.ok.type === "render:ok" && ALL.every((o) => len(a.chunks, o) === want) && a.chunks.every((c) => c.channels[0].length <= 44100 && c.channels.length === 2) &&
        ALL.every((o) => a.chunks.filter((c) => c.output === o).every((c, i, cs) => c.frameOffset === (i ? cs[i - 1].frameOffset + cs[i - 1].channels[0].length : 0))));
  check(`render:ok is {type, id, renderId, frames: ${want}, outputs, build} after the last chunk`,
        Object.keys(a.ok).sort().join() === "build,frames,id,outputs,renderId,sessionId,type" && a.ok.frames === want &&
        a.ok.outputs.join() === ALL.join() && a.ok.build === "t" && a.ok.renderId === "w1");
  check("render via the session twice: the same bytes", a.chunks.length === b.chunks.length &&
        a.chunks.every((c, i) => c.output === b.chunks[i].output && same(c.channels[0], b.chunks[i].channels[0]) && same(c.channels[1], b.chunks[i].channels[1])));
  const pw = h.got.filter((m) => m.type === "render-progress" && m.renderId === "w2");
  check(`progress: render-progress messages, fraction 0..1, the last 1 (${pw.length} for w2)`,
        pw.length > 0 && pw.at(-1).fraction === 1 && pw.every((m, i) => !i || m.fraction >= pw[i - 1].fraction));
  h.close();
}

// ---- sessions apart: what a request of an ended session sends goes nowhere, not into the next session
{
  const ctl = { initGate: null, stateGate: null, renders: [] };
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); p.open = open; return p; };
  const engine = {
    init: async () => { if (ctl.initGate) await ctl.initGate; return { stateRevision: 1 }; },
    context() {}, transport() {}, close() {},
    getState: async () => { if (ctl.stateGate) await ctl.stateGate; return { state: new ArrayBuffer(4), stateVersion: 1, stateRevision: 1 }; },
    render: (r, sink) => new Promise((res, rej) => ctl.renders.push({ r, sink, res, rej })),
  };
  const session = new PluginSession({ engine, post: () => {}, plugin: { id: "x", version: "t", build: "b1" } });
  const conn = (sid) => {
    const ch = new MessageChannel(), got = [];
    ch.port1.onmessage = (e) => got.push(e.data);
    const ok = session.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL, sessionId: sid, generation: 1, host: {} },
                                         origin: HOST, isParent: true, ports: [ch.port2] });
    return { ok, got, send: (m) => ch.port1.postMessage({ sessionId: sid, ...m }), close: () => ch.port1.close() };
  };
  ctl.initGate = gate();
  const a = conn("A");
  a.send({ type: "init", id: "ia", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await until(() => session.initing);
  a.send({ type: "close" });
  await until(() => session.state === "closed");
  const b = conn("B");
  ctl.initGate.open();                                 // (A's init finishes now, its session gone)
  ctl.initGate = null;
  await sleep(0);
  b.send({ type: "get-state", id: "gb" });
  await until(() => b.got.some((m) => m.id === "gb"));
  const gb = b.got.find((m) => m.id === "gb");
  check("a late init of an ended session: the new session not inited (bad-request), no init:ok anywhere",
        b.ok === 1 && session.inited === false && session.state === "initializing" && gb && gb.code === "bad-request" &&
        !a.got.concat(b.got).some((m) => m.type === "init:ok"));
  b.send({ type: "init", id: "ib", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await until(() => b.got.some((m) => m.id === "ib"));
  b.send({ type: "render", id: "rb", ...req({ renderId: "rb" }) });
  await until(() => ctl.renders.length === 1);
  ctl.stateGate = gate();
  b.send({ type: "get-state", id: "gs" });
  b.send({ type: "close" });
  await until(() => session.state === "closed");
  const c = conn("C");
  c.send({ type: "init", id: "ic", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await until(() => c.got.some((m) => m.id === "ic"));
  c.send({ type: "render", id: "rc", ...req({ renderId: "rc" }) });
  await until(() => ctl.renders.length === 2);
  ctl.stateGate.open();
  const old = ctl.renders[0];
  let cancelled = false;
  try { await old.sink.chunk("mix", 0, [new Float32Array(4), new Float32Array(4)]); } catch (e) { cancelled = e.code === "cancelled"; }
  old.sink.progress(0.5);
  old.res({ frames: 4, outputs: ["mix"] });
  const cur = ctl.renders[1];
  await cur.sink.chunk("mix", 0, [new Float32Array(4), new Float32Array(4)]);
  cur.res({ frames: 4, outputs: ["mix"] });
  await until(() => c.got.some((m) => m.id === "rc"));
  const ofB = c.got.filter((m) => m.renderId === "rb" || m.id === "rb" || m.id === "gs");
  const okC = c.got.find((m) => m.id === "rc");
  check("a render of an ended session: its sink cancelled, nothing of it (or its get-state) in the next session",
        cancelled && ofB.length === 0 && c.got.every((m) => m.sessionId === "C") && !b.got.some((m) => m.id === "gs" || m.id === "rb"));
  check("the next session's render runs alongside (not busy), its render:ok has its build",
        ctl.renders.length === 2 && okC && okC.type === "render:ok" && okC.build === "b1" && okC.frames === 4 && session.render === null);
  a.close(); b.close(); c.close();
  session.close();
  const s2 = new PluginSession({ engine, post: () => {}, plugin: { id: "x", version: "t", build: "b1" } });
  s2.stopAccepting();
  const ch = new MessageChannel();
  check("a connect after going standalone: refused", s2.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL,
        sessionId: "late", generation: 1, host: {} }, origin: HOST, isParent: true, ports: [ch.port2] }) === 0 && s2.port === null);
  ch.port1.close();
}

// ---- the site (site.mjs): per channel, the embedders in build-info.js and _headers alike, the manifest, the CSP
{
  const site = (channel, env = {}) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `fm1open-site-${channel}-`));
    const r = spawnSync(process.execPath, [path.join(ROOT, "web/plugin/site.mjs"), path.resolve(wasmPath), out, "V14"],
                        { cwd: ROOT, env: { ...process.env, PLUGIN_ALLOW_DIRTY: "", ...env, PLUGIN_CHANNEL: channel }, encoding: "utf8" });
    return { out, ...r };
  };
  const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim() !== "";
  const checkSite = async (channel, s) => {
    const rd = (f) => fs.readFileSync(path.join(s.out, f), "utf8");
    const headers = rd("_headers"), m = JSON.parse(rd("tutti-plugin.json"));
    const info = await import(pathToFileURL(path.join(s.out, "plugin/build-info.js")).href);
    const anc = [...headers.matchAll(/frame-ancestors ([^;\n]*)/g)].map((x) => x[1]);
    const page = rd("plugin/index.html");
    const csp = /\/plugin\/\*\n  Content-Security-Policy: ([^\n]*)/.exec(headers)[1];
    check(`site ${channel}: build-info EMBEDDERS and every frame-ancestors = ${CHANNELS[channel].join(" ")}`,
          JSON.stringify(info.EMBEDDERS) === JSON.stringify(CHANNELS[channel]) && anc.length === 2 &&
          anc.every((a) => a === CHANNELS[channel].join(" ")) && info.BUILD.channel === channel);
    check(`site ${channel}: manifest id, name, vendor, licence, notice, outputs mix t1..t5 t67 t8, seek false, midiChannels 0..7, the pinned source`,
          m.id === "com.weavejam.fm1open" && m.name === "FM1 Open" && m.vendor === "weavejam (FM1 Open firmware by M-VAVE, open source)" &&
          m.license === "GPL-3.0-only" && m.notice === "Unofficial plugin build of M-VAVE's open-source FM1 Open firmware by weavejam. Not affiliated with or endorsed by M-VAVE." &&
          m.upstream === "https://github.com/m-vave/fm1_open" && m.capabilities.outputs.map((o) => o.id).join() === ALL.join() &&
          m.capabilities.seek === false && m.capabilities.midiChannels.map((c) => `${c.channel}:${c.name}`).join() === "0:T1,1:T2,2:T3,3:T4,4:T5,5:T6,6:T7,7:T8" &&
          m.capabilities.ownSequencer && m.capabilities.acceptsMidi && m.capabilities.tempoMap === "constant" && !m.capabilities.webMidi &&
          m.capabilities.stemsSumToMix === false && m.capabilities.sampleRates.join() === "44100,48000" &&
          m.state.version === STATE_VERSION && m.entry === "/plugin/" &&
          /^https:\/\/github\.com\/weavejam\/fm1_open\/tree\/[0-9a-f]{40}$/.test(m.source) && m.source === info.BUILD.source &&
          /^0\.1\.0\+fm1open\.v14/.test(m.version) && /^[0-9a-f]{16}$/.test(m.build));
    check(`site ${channel}: the page: no inline script; its CSP (scripts from the site only), CORS * on the manifest, wasm's type`,
          !/<script(?![^>]*\bsrc=)/.test(page) && page.includes('<script type="module" src="tutti.js">') && page.includes('<script src="I18n.js">') &&
          csp.startsWith("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; ") &&
          ["style-src 'self' 'unsafe-inline'", "frame-src 'none'", "form-action 'none'", "object-src 'none'"].every((d) => csp.includes(d)) &&
          /\/tutti-plugin\.json\n  Access-Control-Allow-Origin: \*\n  Cache-Control: no-cache/.test(headers) &&
          /\/\*\.wasm\n  Content-Type: application\/wasm/.test(headers));
    const credits = rd("credits.html");
    check(`site ${channel}: credits: the notice, upstream, GPL text (LICENSE.md) and THIRD_PARTY.md shipped, no binary SDK`,
          credits.includes("Not affiliated with or endorsed by M-VAVE") && credits.includes("github.com/m-vave/fm1_open") &&
          rd("licenses/LICENSE.md").includes("GNU GENERAL PUBLIC LICENSE") && rd("licenses/THIRD_PARTY.md").startsWith("# Third-party notices") &&
          !fs.readdirSync(path.join(s.out, "plugin")).some((f) => f.endsWith(".a")) &&
          fs.readFileSync(path.join(s.out, "plugin/I18n.js")).equals(fs.readFileSync(path.join(ROOT, "sdk/I18n.js"))));
    fs.rmSync(s.out, { recursive: true, force: true });
  };
  const pv = site("preview", { PLUGIN_ALLOW_DIRTY: "1" });
  check(`site preview: built (${dirty ? "a dirty tree, allowed for a preview: marked" : "a clean tree"})`, pv.status === 0 &&
        (!dirty || fs.readFileSync(path.join(pv.out, "tutti-plugin.json"), "utf8").includes(".dirty")));
  if (pv.status === 0) await checkSite("preview", pv); else console.log(pv.stderr);
  const pr = site("production");
  if (dirty) {
    const forced = site("production", { PLUGIN_ALLOW_DIRTY: "1" });
    check("site production on a dirty tree: refused (also with PLUGIN_ALLOW_DIRTY=1)", pr.status === 1 && /changes not in/.test(pr.stderr) && forced.status === 1);
    console.log("plugin:   (the production site's checks need a clean tree: commit, then run again)");
    for (const x of [pr, forced]) fs.rmSync(x.out, { recursive: true, force: true });
  } else {
    check("site production: built", pr.status === 0);
    await checkSite("production", pr);
  }
  const bad = site("staging", { PLUGIN_ALLOW_DIRTY: "1" });
  check("site: an unknown PLUGIN_CHANNEL refused", bad.status === 1 && /PLUGIN_CHANNEL/.test(bad.stderr));
  fs.rmSync(bad.out, { recursive: true, force: true });
}

// ---- edit mode: the live device, edits -> revisions, state-changed debounced, get-state, the round trip, commit
{
  const live = new NodeLive(), h = harness({ live });
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  const i = await h.reply("i");
  check("edit mode: init:ok, the live device loaded (a new FM1)", i.type === "init:ok" && live.loads === 1);
  h.send({ type: "context", context: ctxOf(97.5) });
  h.send({ type: "context", context: { timeMap: { tempoPoints: [] } } });
  h.send({ type: "get-state", id: "g0" });
  await h.reply("g0");
  check(`context after init: to the live preview, its tempo ${live.tempos.join(" -> ")}; a malformed one changes nothing`,
        live.tempos.join() === "120,97.5" && live.tempo.bpm === 97.5 && !h.got.some((m) => m.type === "error"));
  h.send({ type: "get-state", id: "g1" });
  const g1 = await h.reply("g1");
  const t0 = Date.now();
  live.edit((d) => d.load(grooveProject()));
  live.edit((d) => d.ex.sim_step(2, 1));
  live.edit((d) => d.ex.sim_select(2, 6));
  const early = h.got.filter((m) => m.type === "state-changed").length;
  const sc = await h.wait((m) => m.type === "state-changed", 5000);
  const waited = Date.now() - t0;
  h.send({ type: "get-state", id: "g2" });
  const g2 = await h.reply("g2");
  check(`edits: one state-changed after ${waited} ms (debounced, >= 500), revision ${g1.stateRevision} -> ${sc.stateRevision}`,
        early === 0 && waited >= 500 && sc.stateRevision === g1.stateRevision + 1 && h.got.filter((m) => m.type === "state-changed").length === 0);
  h.send({ type: "get-state", id: "g3" });
  const g3 = await h.reply("g3");
  check("get-state after edits: the new revision; again without edits: the same revision, the same bytes",
        g2.type === "get-state:ok" && g2.stateRevision === sc.stateRevision && g2.stateVersion === STATE_VERSION &&
        g3.stateRevision === g2.stateRevision && stateEquals(g2.state, g3.state) && !stateEquals(g1.state, g2.state));
  const chunks = collect(h, "e1");
  h.send({ type: "render", id: "e1", ...req({ renderId: "e1", stateRevision: g2.stateRevision, outputs: ["mix", "t1", "t8"], toBeat: 8 }) });
  await h.reply("e1");
  const h2 = harness();
  h2.connect();
  h2.send({ type: "init", id: "j", sampleRate: 44100, context: ctxOf(120), state: g2.state, stateVersion: g2.stateVersion, mode: "render" });
  const j = await h2.reply("j");
  const chunks2 = collect(h2, "e2");
  h2.send({ type: "render", id: "e2", ...req({ renderId: "e2", stateRevision: j.stateRevision, outputs: ["mix", "t1", "t8"], toBeat: 8 }) });
  await h2.reply("e2");
  check(`state round trip: get-state -> init in a new session -> the same render (${chunks.length} chunks, peak ${peak(chunks[0].channels[0]).toFixed(3)})`,
        chunks.length === chunks2.length && peak(chunks[0].channels[0]) > 0.05 &&
        chunks.every((c, k) => c.output === chunks2[k].output && same(c.channels[0], chunks2[k].channels[0]) && same(c.channels[1], chunks2[k].channels[1])));
  live.edit((d) => d.ex.sim_step(4, 1));
  h.send({ type: "render", id: "e3", ...req({ renderId: "e3", stateRevision: g1.stateRevision }) });
  const e3 = await h.reply("e3");
  check("an older revision (kept) still renders", e3.type === "render:ok");
  h.send({ type: "transport", generation: 3, playing: true, beat: 4, atEpochMs: 1000, loop: null });
  h.send({ type: "transport", generation: 3, playing: "yes", beat: 4, atEpochMs: 1000, loop: null });
  h.send({ type: "get-state", id: "g4" });
  await h.reply("g4");
  check("transport: to the live device (preview); a malformed one dropped", live.transports.length === 1 && live.transports[0].beat === 4);
  const steps = live.dev.ex.tutti_pattern_steps();
  h.session.commit({ fromBeat: 0, toBeat: steps / 4, outputs: ["mix"], lengthBeats: steps / 4 });
  h.session.commit({ fromBeat: 0, toBeat: 4, lengthBeats: -1 });
  const cm = await h.wait((m) => m.type === "commit"), cm2 = await h.wait((m) => m.type === "commit");
  check(`commit (Render to tuttidaw): {fromBeat 0, toBeat ${cm.toBeat}, outputs, lengthBeats ${cm.lengthBeats}} (the pattern's ${steps} sixteenths); a bad lengthBeats left out`,
        cm.outputs[0] === "mix" && cm.toBeat === 4 && cm.lengthBeats === 4 && cm.sessionId === h.sid && !("lengthBeats" in cm2) && cm2.toBeat === 4);
  h.send({ type: "close" });
  await until(() => live.closed === true);
  check("close: the live device closed", live.closed === true);
  h.close(); h2.close();
}

// ---- the engine across sessions: a snapshot asked for in a session that ended comes late
{
  const snaps = [], renders = [];
  const live = { load: async () => {}, context() {}, transport() {}, close() {},
                 snapshot: () => new Promise((res) => snaps.push(res)) };
  const engine = new FM1Engine({ render: (st) => { renders.push(st); return { frames: 1, outputs: ["mix"] }; }, blank, live });
  const st = (v) => ({ project: new Uint8Array(PROJECT_BYTES).fill(v), sectors: { 4096: new Uint8Array(4096).fill(v) }, meta: {} });
  await engine.init({ context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  engine.changed();
  let ended = false;
  const r1 = engine.render(req({ stateRevision: 2 }), { cancelled: () => ended }).then(() => "rendered", (e) => e.code);
  await until(() => snaps.length === 1);
  ended = true;
  snaps.shift()(st(1));
  check(`a render whose session ended while its state was made: ${await r1}, nothing rendered`, (await r1) === "cancelled" && renders.length === 0);
  engine.changed();
  const g = engine.getState().then(() => "ok", (e) => e.code);
  await until(() => snaps.length === 1);
  const stB = packState(st(2));
  await engine.init({ context: ctxOf(120), state: stB, stateVersion: STATE_VERSION, mode: "edit" });
  snaps.shift()(st(3));
  const gs = await g, now = await engine.getState();
  check(`a late snapshot of an ended session: dropped (${gs}), the new session's revision 1 its init state`,
        gs === "session-ended" && now.stateRevision === 1 && stateEquals(now.state, stB) && engine.states.size === 1 && snaps.length === 0);
  engine.changed();
  const g2 = engine.getState();
  await until(() => snaps.length === 1);
  engine.changed();
  snaps.shift()(st(3));
  const s2 = await g2;
  check(`a change while a snapshot is made: kept as revision ${s2.stateRevision}, now ${engine.revision}`,
        s2.stateRevision === 2 && engine.revision === 3 && engine.dirty && stateEquals(engine.states.get(2).buf, packState(st(3))));
}

// ================================================================== the review fixes of weavejam's FM-1 plugins, here too
// ---- a revision is one state: its snapshot made once, whoever asks for it while it is made
{
  const snaps = [], rendered = [];
  const live = { load: async () => {}, context() {}, transport() {}, close() {},
                 snapshot: () => new Promise((res) => snaps.push(res)) };
  const engine = new FM1Engine({ render: (st) => { rendered.push(st); return { frames: 1, outputs: ["mix"] }; }, blank, live });
  const st = (v) => ({ project: new Uint8Array(PROJECT_BYTES).fill(v), sectors: { 4096: new Uint8Array(4096).fill(v) }, meta: {} });
  await engine.init({ context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  engine.changed();
  const g1 = engine.getState();
  await until(() => snaps.length === 1);
  const g2 = engine.getState();                       // (a second get-state while the first is made)
  const r = engine.render(req({ stateRevision: 2 }), { cancelled: () => false });
  await sleep(0);
  const asked = snaps.length;
  snaps.shift()(st(4));                                // the device as it was asked
  while (snaps.length) snaps.shift()(st(5));           // (an edit meanwhile, its change not in yet: another state)
  const [s1, s2] = await Promise.all([g1, g2]);
  await r;
  check(`one snapshot per revision: ${asked} for get-state, get-state, render of revision 2; one state, the same bytes`,
        asked === 1 && s1.stateRevision === 2 && s2.stateRevision === 2 && stateEquals(s1.state, s2.state) &&
        stateEquals(s1.state, packState(st(4))) && rendered.length === 1 && rendered[0] === engine.states.get(2).state);
  engine.changed();
  const g3 = engine.getState();
  await until(() => snaps.length === 1);
  engine.changed();
  const r3 = engine.render(req({ stateRevision: 3 }), { cancelled: () => false }).then(() => "rendered", (e) => e.code);
  await sleep(0);
  const asked3 = snaps.length;
  while (snaps.length) snaps.shift()(st(5));
  const s3 = await g3;
  check(`a render of a revision still being made (now ${engine.revision}): ${await r3}, its one snapshot`,
        asked3 === 1 && (await r3) === "rendered" && s3.stateRevision === 3 && rendered.at(-1) === engine.states.get(3).state);
}

// ---- the range's limits: frames the device can count, the pre-roll from beat 0, the credits a render holds
{
  const code = (o) => { try { planRender(req(o)); return "ok"; } catch (err) { return err.code; } };
  const far = code({ fromBeat: 1e12, toBeat: 1e12 + 4 });
  const pre = code({ fromBeat: 1300, toBeat: 1304 });  // 650 s of pre-roll at 120 BPM
  const near = code({ fromBeat: 1218, toBeat: 1222 }); // 609 s
  check(`frames past 2^32 from beat 0: ${far}; a pre-roll over 610 s: ${pre}; 609 s: ${near}`,
        far === "bad-request" && pre === "too-large" && near === "ok");
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i");
  h.send({ type: "render", id: "pr", ...req({ renderId: "pr", fromBeat: 1300, toBeat: 1304 }) });
  const pr = await h.reply("pr");
  h.send({ type: "render", id: "cr", ...req({ renderId: "cr", toBeat: 800, outputs: ALL }) });
  await until(() => h.chunks("cr") >= 1);
  for (let i = 0; i < 3; i++) h.send({ type: "render-credit", renderId: "cr", chunks: 1e6 });
  h.send({ type: "get-state", id: "gc" });
  await h.reply("gc");                                 // (the credits taken before this reply)
  const credits = h.session.render ? h.session.render.credits : NaN;
  h.send({ type: "cancel", renderId: "cr" });
  const cr = await h.reply("cr");
  check(`a render with 650 s of pre-roll: ${pr.code}; credits granted 3 x 1e6: ${credits} held (at most 600 s x 8 outputs)`,
        pr.code === "too-large" && credits > 0 && credits <= 4800 && cr.code === "cancelled");
  h.close();
}

// ---- the port's messageerror ends the session: its render cancelled, the port let go, a new connect accepted
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i");
  h.send({ type: "render", id: "me", ...req({ renderId: "me", toBeat: 400 }) });
  await until(() => !!h.session.render);
  const port = h.session.port, r = h.session.render;
  const has = typeof port.onmessageerror === "function";
  if (has) port.onmessageerror(new Event("messageerror"));
  await until(() => h.session.render === null);
  check("port messageerror: the session closed, its render cancelled, the port's handlers off, a new connect accepted",
        has && h.session.state === "closed" && !!r && r.cancel === true && h.session.render === null && h.session.port === null &&
        !port.onmessage && !port.onmessageerror && h.connect({ generation: 2 }) === 1);
  h.close();
}

// ---- a PLAY track's edit through the session: a new revision; get-state, a fresh init, a use-B render sounds it
{
  const live = new NodeLive();
  const h = harness({ live });
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  await h.reply("i");
  live.edit((d) => playOn(d));
  const r1 = (await h.wait((m) => m.type === "state-changed", 5000)).stateRevision;
  h.send({ type: "get-state", id: "g1" });
  const g1 = await h.reply("g1");
  live.edit((d) => timbreEdit(d));
  const r2 = (await h.wait((m) => m.type === "state-changed", 5000)).stateRevision;
  h.send({ type: "get-state", id: "g2" });
  const g2 = await h.reply("g2");
  const h2 = harness();
  h2.connect();
  h2.send({ type: "init", id: "j", sampleRate: 44100, context: ctxOf(120), state: g2.state, stateVersion: g2.stateVersion, mode: "render" });
  const j = await h2.reply("j");
  const note = { input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: 1, pitch: 60, velocity: 110, channel: 0 }] }, outputs: ["t1"], toBeat: 2 };
  const chunks = collect(h2, "b1");
  h2.send({ type: "render", id: "b1", ...req({ renderId: "b1", stateRevision: j.stateRevision, ...note }) });
  await h2.reply("b1");
  const cat = (cs) => { const a = new Float32Array(cs.reduce((n, c) => n + c.channels[0].length, 0)); let k = 0; for (const c of cs) { a.set(c.channels[0], k); k += c.channels[0].length; } return a; };
  const heard = cat(chunks), dflt = (await renderAll(unpackState(g1.state, g1.stateVersion), req(note))).out.t1[0];
  check(`a PLAY track's timbre edited live: revision ${r1} -> ${r2}; get-state, init in a fresh session, use B on channel 0: the edited timbre, not the default's`,
        r2 === r1 + 1 && g2.stateRevision === r2 && g2.stateVersion === STATE_VERSION && j.type === "init:ok" && peak(heard) > 0.01 &&
        !same(heard, dflt) && same(heard, (await useB(live.dev.state())).out.t1[0]));
  h.close(); h2.close();
}

// ---- a version 1 state given to init: read, given back as this version's
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: packV1(groove), stateVersion: 1, mode: "render" });
  const i = await h.reply("i");
  h.send({ type: "get-state", id: "g" });
  const g = await h.reply("g");
  const back = unpackState(g.state, g.stateVersion);
  check(`init with a version 1 state: ${i.type}; get-state gives version ${g.stateVersion}, the same project and flash`,
        i.type === "init:ok" && g.stateVersion === STATE_VERSION && same(back.project, groove.project) &&
        Object.keys(groove.sectors).length === Object.keys(back.sectors).length && Object.keys(groove.sectors).every((k) => same(groove.sectors[k], back.sectors[k])));
  h.close();
}

// ---- the signature: every edit that changes the state changes it; what the state does not keep leaves it
{
  const d = await Dev.make(groove, { hosted: true });
  d.run(300);
  const edits = {
    "a step": (x) => x.ex.sim_step(6, 1),
    "a PLAY role": (x) => playOn(x, 0),
    "a PLAY track's timbre": (x) => timbreEdit(x),
    "a PLAY track's arpeggiator": (x) => x.ex.tutti_arp_edit(0, 1, 1),
    "an input channel": (x) => x.ex.tutti_track_setting(0, 1, 3),
    "an OFF role": (x) => x.ex.tutti_track_setting(2, 0, 2),
    "the DX7 library": (x) => { x.ex.sim_library_read(2); const b = new Uint8Array(x.ex.memory.buffer, x.ex.sim_file(), 4096).slice(); b[5] ^= 1; x.file(b); x.ex.sim_library_write(2); },
    "a MIDI setting (written 1.5 s on)": (x) => { x.ex.sim_midi_edit(3, 1, 2); x.run(1700); },
  };
  const unchanged = [];
  for (const [what, fn] of Object.entries(edits)) {
    const s = d.ex.tutti_sig();
    fn(d);
    d.run(50);
    if (d.ex.tutti_sig() === s) unchanged.push(what);
  }
  check(`the signature: every edit changes it (${Object.keys(edits).join(", ")}; unchanged: ${unchanged.join(", ") || "none"})`, unchanged.length === 0);
  d.run(1700);
  const s = d.ex.tutti_sig();
  d.ex.tutti_tempo(133);
  d.ex.tutti_live_play(0);
  d.run(400);
  d.file(Uint8Array.of(0x90, 60, 100)); d.ex.sim_midi(3);
  d.run(100);
  d.file(Uint8Array.of(0x80, 60, 0)); d.ex.sim_midi(3);
  d.ex.tutti_live_stop();
  d.run(100);
  check("the signature: the host's tempo, the transport, notes played leave it", d.ex.tutti_sig() === s);
}

// ---- the page's worklet (worklet-tutti.js) in Node: the host's transport and its generations; its sig messages
{
  let proc = null;
  globalThis.sampleRate = 44100;
  globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { sent: [], postMessage(m) { this.sent.push(m); } }; } };
  globalThis.registerProcessor = (name, C) => { proc = new C(); };
  await import(pathToFileURL(path.join(ROOT, "web/plugin/worklet-tutti.js")).href);
  const out = [[new Float32Array(128), new Float32Array(128)]];
  const run = (ms) => { for (let k = 0; k < ms * 44.1; k += 128) { proc.process([], out); globalThis.currentFrame += 128; } };
  await proc.onMessage({ type: "load", wasm: fs.readFileSync(wasmPath), state: groove, hosted: true, knob: 1023 });
  const c = proc.c, now = () => globalThis.currentFrame;
  await proc.onMessage({ type: "tutti-tempo", bpm: 120 });
  await proc.onMessage({ type: "tutti-play", gen: 1, playing: true, atFrame: now(), beat: 8, bpm: 120 });
  run(500);
  const p1 = c.tutti_live_pos();
  // a new generation starting in a second at beat 0: the old run stops now (not at the new start), one start
  await proc.onMessage({ type: "tutti-play", gen: 2, playing: true, atFrame: now() + 44100, beat: 0, bpm: 120 });
  const stopped = c.tutti_playing();
  run(900);
  const between = c.tutti_playing();
  run(300);
  const pos = c.tutti_live_pos();
  check(`worklet: a new generation stops the old run at once (playing: ${stopped}, ${between} until its start), then plays from its beat (${p1.toFixed(2)} -> ${pos.toFixed(2)} sixteenths, 0.2 s in: ~1.6)`,
        p1 > 33 && stopped === 0 && between === 0 && c.tutti_playing() === 1 && Math.abs(pos - 1.6) < 0.2);
  // the same generation again, on time: it continues; a pre-roll's generation (beat < 0): the old run stops at once,
  // nothing until beat 0
  await proc.onMessage({ type: "tutti-play", gen: 2, playing: true, atFrame: now(), beat: (c.tutti_live_pos() + 128 / 44100 * 8) / 4, bpm: 120 });
  run(250);
  const cont = c.tutti_live_pos();
  await proc.onMessage({ type: "tutti-play", gen: 3, playing: true, atFrame: now(), beat: -1, bpm: 120 });
  const pre = c.tutti_playing();
  run(400);
  const preIn = c.tutti_playing();
  run(200);
  check(`worklet: the same generation on time continues (${cont.toFixed(2)}, ~3.6); a pre-roll's generation: the old run stopped at once (${pre}, ${preIn} in it), started at beat 0 (${c.tutti_live_pos().toFixed(2)} sixteenths 0.1 s on, ~0.8)`,
        Math.abs(cont - 3.6) < 0.2 && pre === 0 && preIn === 0 && Math.abs(c.tutti_live_pos() - 0.8) < 0.2);
  await proc.onMessage({ type: "tutti-play", gen: 3, playing: false });
  // the signature: an edit (a page command, a role set on the device) posted as a sig within ~200 ms
  const sigs = () => proc.port.sent.filter((m) => m.type === "sig").length;
  run(300);
  const n0 = sigs();
  run(300);
  const idle = sigs() - n0;
  await proc.onMessage({ type: "cmd", id: 1, cmd: { type: "step", index: 2, toggle: true } });
  run(300);
  const n1 = sigs();
  c.tutti_track_setting(0, 0, 1);
  run(300);
  const n2 = sigs();
  c.sim_timbre_export();
  const t = new Uint8Array(c.memory.buffer, c.sim_file(), 223).slice();
  t[11 + 134] = (t[11 + 134] + 5) % 32;
  await proc.onMessage({ type: "cmd", id: 2, cmd: { type: "import", timbre: true, data: t } });
  run(300);
  check(`worklet: no edit, no sig (${idle}); a step, a PLAY role, a PLAY track's timbre import: a sig each (${n1 - n0 - idle}, ${n2 - n1}, ${sigs() - n2})`,
        idle === 0 && n1 - n0 === 1 && n2 - n1 === 1 && sigs() - n2 === 1);
}

console.log(fails ? `plugin: ${fails} FAILED` : "plugin: all ok");
process.exit(fails ? 1 : 0);
