// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page's live FM1 Open: fm1open.wasm (web/plugin/fm1_plugin.c) as the device in an AudioWorklet, its
// clock the audio (sim_render: a block of 128 frames, the control task every 10 ms as in the workbench). The page's
// requests are the workbench's simulator operations (sdk/Simulator.js FM1Core.command, ported here: panel, keys, LCD,
// projects, presets, timbres, DX7 library, samples), its frames FM1Core.frame's (the screen, the state bytes, the LCD
// targets); and tuttidaw's: the host's tempo, its transport (preview), the state. After weavejam's FM-1 plugins
// (web/plugin/worklet-tutti.js). Messages:
//   load         {wasm (bytes, the first time), state (state.js), hosted, knob}: a fresh device with this state
//   cmd          {id?, cmd: {type, ...}}: an operation (FM1Core.command's types); -> {type: reply, id, data | error}
//   tutti-tempo  {bpm}: the host's tempo (fractional)
//   tutti-play   {gen, playing, atFrame, beat, bpm}: the host's transport, listen-only: `beat` sounds at this context's
//                frame `atFrame`; the same generation again: only a drift of over 20 ms moves it; not playing: stop
//   snapshot     {id}: the state now (state.js deviceState) -> {type: snapshot, id, state, sig}
//   steps        {id}: the pattern's length in sixteenths (fm1_plugin.c tutti_pattern_steps) -> {type: steps, id, steps}
// and out: {type: ready, sig}, {type: frame, ...} (~20 a second), {type: sig, sig} when the state changed,
// {type: error, message}.
import { bootDevice, deviceState } from "./state.js";

const DRIFT = 0.02;                                    // s
const FRAME_EVERY = 2205;                              // frames between frames to the page (~20 a second)
const SIG_EVERY = 8820;                                // frames between looks at the state's signature (~200 ms)
const SAMPLE_OFFSET = 69632, SAMPLE_REGION = 466944, SAMPLE_CAPACITY = 446464;   // instrument.h, sdk/Samples.js
const label = (bytes) => { let t = ""; for (const b of bytes) { if (!b) break; t += String.fromCharCode(b); } return t; };
const sameBytes = (a, b) => { if (!a || a.length !== b.length) return false; for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false; return true; };

class FM1Tutti extends AudioWorkletProcessor {
  constructor() {
    super();
    this.compiled = null;                              // (the wasm compiled, a promise: loads wait for it)
    this.c = null;
    this.bpm = 0;
    this.play = null;                                  // a start to come: {gen, atFrame, beat, bpm}
    this.at = null;                                    // playing: {gen, frame, beat, bpm} (beat at that frame)
    this.frames = 0;
    this.sigFrames = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async onMessage(m) {
    try {
      if (m.type === "load") {                         // (one load after another: a second waits for the first's compile)
        if (m.wasm) this.compiled = WebAssembly.compile(m.wasm);
        this.loading = (this.loading || Promise.resolve()).then(() => this.load(m), () => this.load(m));
        return await this.loading;
      }
      if (m.type === "tutti-tempo") {
        this.bpm = m.bpm;
        if (this.c) this.c.tutti_tempo(m.bpm);         // (out of FM1 Open's range: refused, the tempo stays)
        return;
      }
      const c = this.c;
      if (!c) { if (m.id) this.port.postMessage({ type: "reply", id: m.id, error: "仿真尚未载入" }); return; }
      if (m.type === "cmd") {
        try {
          const data = this.command(m.cmd);
          this.port.postMessage({ type: "reply", id: m.id, data }, data && ArrayBuffer.isView(data) ? [data.buffer] : []);
        } catch (err) { this.port.postMessage({ type: "reply", id: m.id, error: String(err && err.message || err) }); }
        this.publish();
        return;
      }
      if (m.type === "tutti-play") return this.schedule(m);
      if (m.type === "snapshot") {
        const state = deviceState(c);
        this.sig = c.tutti_sig() >>> 0;
        this.port.postMessage({ type: "snapshot", id: m.id, state, sig: this.sig });
        return;
      }
      if (m.type === "steps") { this.port.postMessage({ type: "steps", id: m.id, steps: c.tutti_pattern_steps() }); return; }
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message || err), id: m && m.id });
    }
  }

  async load(m) {
    const { exports: c } = await WebAssembly.instantiate(await this.compiled, {});
    c._initialize();
    if (this.bpm) c.tutti_tempo(this.bpm);
    bootDevice(c, m.state, { hosted: !!m.hosted, bpm: this.bpm });
    if (m.knob != null) c.sim_control(3, 0, m.knob);
    this.c = c;
    this.out = null;
    this.play = this.at = null;
    this.lastFrame = this.lastScreen = undefined;
    this.screen = null;
    this.sig = c.tutti_sig() >>> 0;
    this.port.postMessage({ type: "ready", sig: this.sig, factories: this.factories() });
    this.publish(true);
  }

  factories() {
    const c = this.c, names = [];
    for (let i = 0; i < 64; i++) {
      const at = c.sim_factory_name(i);
      if (!at) break;
      names.push(label(new Uint8Array(c.memory.buffer, at, 13)));
    }
    return names;
  }

  // sdk/Simulator.js FM1Core.command, its operations as the workbench's page sends them; and the sample bank read back
  command(message) {
    const c = this.c;
    let result = 0, data;
    const file = (n) => new Uint8Array(c.memory.buffer, c.sim_file(), n);
    switch (message.type) {
      case "control": c.sim_control(message.kind, message.index, message.value); break;
      case "release": c.sim_release(); break;
      case "panic": c.sim_panic(); break;
      case "tapTempo": c.sim_tap_tempo(); break;
      case "select": result = c.sim_select(message.track, message.source); break;
      case "open": result = c.sim_open(message.page); if (result) throw Error("当前音源不支持此编辑页。"); break;
      case "preset": result = c.sim_preset(message.index); break;
      case "step": result = c.sim_step(message.index, message.toggle ? 1 : 0); break;
      case "lcd": result = c.sim_lcd(message.context, message.action, message.index, message.owner, message.delta); break;
      case "midi":
        if (!message.data || message.data.length > 1024) throw Error("MIDI 数据无效");
        file(message.data.length).set(message.data);
        result = c.sim_midi(message.data.length);
        break;
      case "export":
        result = message.timbre ? c.sim_timbre_export() : message.patch ? c.sim_patch_export() : c.sim_export();
        if (!result) data = file(message.timbre ? 223 : message.patch ? 156 : 4264).slice();
        break;
      case "factory":
        result = c.sim_factory_project(message.index);
        if (!result) data = file(4264).slice();
        break;
      case "import":
        if (!message.data || (message.timbre ? message.data.length !== 223 : message.patch ? message.data.length !== 156
            : ![4048, 4064, 4264].includes(message.data.length))) throw Error("文件长度无效");
        file(message.data.length).set(message.data);
        result = message.timbre ? c.sim_timbre_import() : message.patch ? c.sim_patch_import() : c.sim_import(message.data.length);
        break;
      case "library-read":
        result = c.sim_library_read(message.bank);
        if (!result) data = file(4096).slice();
        break;
      case "library-write":
        if (!(message.data instanceof Uint8Array) || message.data.length !== 4096) throw Error("音色库长度无效");
        file(4096).set(message.data);
        result = c.sim_library_write(message.bank);
        break;
      case "clear": c.sim_clear(); break;
      case "samples": {
        if (!(message.data instanceof Uint8Array) || message.data.length < 512 || message.data.length > SAMPLE_CAPACITY) throw Error("采样库长度无效");
        const flash = new Uint8Array(c.memory.buffer, c.sim_flash() + SAMPLE_OFFSET, SAMPLE_REGION), previous = flash.slice();
        // keep the final 20480 bytes (the DX7 library and the tuning), as the workbench does
        flash.fill(255, 0, SAMPLE_CAPACITY);
        flash.set(message.data);
        result = c.sim_sample_bank(message.data.length);
        if (result) {
          new Uint8Array(c.memory.buffer, c.sim_flash() + SAMPLE_OFFSET, SAMPLE_REGION).set(previous);
          c.sim_sample_bank(previous.length);
        }
        break;
      }
      case "sample-bank": {                            // the bank as stored (its header says its size)
        const at = c.sim_flash() + SAMPLE_OFFSET, size = new DataView(c.memory.buffer, at + 8, 4).getUint32(0, true);
        data = new Uint8Array(c.memory.buffer, at, size >= 512 && size <= SAMPLE_REGION ? size : 512).slice();
        break;
      }
      case "factory-bank": data = new Uint8Array(c.memory.buffer, c.sim_factory(), c.sim_factory_size()).slice(); break;
      default: throw Error("未知仿真操作");
    }
    if (result) throw Error(result === -8 ? "内存不足，当前项目保持不变" : "当前音源或参数不支持此操作");
    return data;
  }

  // sdk/Simulator.js FM1Core.frame: what the page draws (the screen's changed bands, the state bytes, the LCD's targets)
  frame(force) {
    const c = this.c, message = { type: "frame", state: new Uint8Array(c.memory.buffer, c.sim_state(), 225).slice() };
    const name = new Uint8Array(c.memory.buffer, c.sim_project_name(), 12), position = c.sim_preset_position();
    const targets = c.sim_lcd_targets(), count = c.sim_lcd_count();
    const labels = new Uint8Array(c.memory.buffer, c.sim_knobs(), 128);
    const bytes = new Uint8Array(c.memory.buffer, targets, count * 64), words = new Int32Array(c.memory.buffer, targets, count * 16);
    const first = c.sim_step_first(), context = c.sim_lcd_context(), mask = c.sim_lcd_mask();
    if (!this.screen || this.screen.first !== first || this.screen.context !== context || this.screen.mask !== mask ||
        !sameBytes(this.labels, labels) || !sameBytes(this.targets, bytes)) {
      this.labels = labels.slice();
      this.targets = bytes.slice();
      this.screen = { first, context, mask,
        knobs: Array.from({ length: 4 }, (_, i) => [0, 1].map((f) => label(labels.subarray(i * 32 + f * 16, i * 32 + f * 16 + 16)))),
        targets: Array.from({ length: count }, (_, i) => ({
          rect: Array.from(words.subarray(i * 16, i * 16 + 4)), action: words[i * 16 + 4], index: words[i * 16 + 5], owner: words[i * 16 + 6],
          label: label(bytes.subarray(i * 64 + 32, i * 64 + 48)), value: label(bytes.subarray(i * 64 + 48, i * 64 + 64)),
        })) };
    }
    message.screen = this.screen;
    message.workspace = { name: String.fromCharCode(...name).trim(), slot: position & 255, factory: (position & 768) === 768,
                          dirty: !!c.sim_project_dirty() };
    message.countIn = c.sim_count_in();
    message.hostPlaying = !!(this.at || this.play);
    const revision = c.sim_frame_revision();
    if (force || revision !== this.lastFrame) {
      const changed = c.sim_frame_changes(), bands = force || this.lastFrame === undefined ? 32767 : changed;
      const source = new Uint16Array(c.memory.buffer, c.sim_pixels(), 57600);
      if (bands === 32767) message.pixels = source.slice();
      else {
        let n = 0;
        for (let b = bands; b; b &= b - 1) n++;
        message.pixels = new Uint16Array(n * 3840);
        for (let band = 0, at = 0; band < 15;) {
          if (!(bands & (1 << band))) { band++; continue; }
          const first = band;
          while (band < 15 && (bands & (1 << band))) band++;
          const run = source.subarray(first * 3840, band * 3840);
          message.pixels.set(run, at);
          at += run.length;
        }
      }
      message.pixelBands = bands;
      this.lastFrame = revision;
    }
    return message;
  }
  publish(force = false) {
    const m = this.frame(force);
    this.port.postMessage(m, [m.state.buffer, ...(m.pixels ? [m.pixels.buffer] : [])]);
  }

  // the host's transport (protocol 9): where it is at a context frame
  schedule(m) {
    if (!m.playing) {
      this.play = this.at = null;
      this.c.tutti_live_stop();
      return;
    }
    const run = this.at;
    if (run && run.gen === m.gen) {                    // still the same run: only a drift moves it
      const want = m.beat + ((currentFrame + 128 - m.atFrame) / sampleRate) * m.bpm / 60;   // (heard a block on)
      const ours = this.c.tutti_live_pos() / 4;
      if (Math.abs(want - ours) * 60 / m.bpm <= DRIFT) return;
    }
    this.play = { gen: m.gen, atFrame: m.atFrame, beat: m.beat, bpm: m.bpm };
  }

  process(inputs, outputs) {
    const c = this.c, out = outputs[0];
    if (!c) return true;
    const n = out[0].length, p = this.play;
    if (p && currentFrame + n > p.atFrame) {          // (the quantum it starts in): placed where the host is then
      this.play = null;
      // the device sounds a block after it renders it (sim_render): placed for the frame a block on
      const beat = p.beat + ((currentFrame + 128 - p.atFrame) / sampleRate) * p.bpm / 60;
      if (beat >= 0) {
        c.tutti_live_play(beat * 4);
        this.at = { gen: p.gen };
      } else this.play = p;                            // (not yet: the host plays it later)
    }
    let at = 0;
    while (at < n) {
      if (!this.out || this.pos >= 128) {
        const ptr = c.sim_render();                    // (always the same block: a view made again only when needed)
        if (!this.out || this.out.buffer !== c.memory.buffer || this.out.byteOffset !== ptr) this.out = new Float32Array(c.memory.buffer, ptr, 256);
        this.pos = 0;
      }
      if (this.out.buffer !== c.memory.buffer) this.out = new Float32Array(c.memory.buffer, this.out.byteOffset, 256);
      const k = Math.min(128 - this.pos, n - at);
      for (let i = 0; i < k; i++) {
        out[0][at + i] = this.out[2 * (this.pos + i)];
        if (out[1]) out[1][at + i] = this.out[2 * (this.pos + i) + 1];
      }
      this.pos += k;
      at += k;
    }
    this.frames += n;
    if (this.frames >= FRAME_EVERY) { this.frames = 0; this.publish(); }
    this.sigFrames += n;
    if (this.sigFrames >= SIG_EVERY) {
      this.sigFrames = 0;
      const sig = c.tutti_sig() >>> 0;
      if (sig !== this.sig) { this.sig = sig; this.port.postMessage({ type: "sig", sig }); }
    }
    return true;
  }
}
registerProcessor("fm1-tutti", FM1Tutti);
