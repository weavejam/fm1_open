// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin's state (tutti-plugin/0 `state`, opaque to the host): everything a user makes on FM1 Open, as the device
// keeps it (web/plugin/README.md "State"):
//   - the working project as the workbench exports it (Simulator.c sim_export: the v4 project of 4064 bytes, the
//     pattern, the eight tracks' sounds, mix, effects, arpeggiators, chords and locks, plus the 200-byte "FM1T" tuning
//     tail), so an edit not saved to a slot is in it too;
//   - the live session (fm1_plugin.c tutti_session, 4272 bytes): what the export leaves out, as it plays now: PLAY
//     tracks' timbres, mix, sends, arpeggiators, mute / solo and tuning (the export has their dormant arrangement
//     rows), the track roles and MIDI input channels;
//   - the flash's sectors that hold something (Simulator.c sim_flash, 536576 bytes): the 16 project slots and the
//     device settings (MIDI, clock, the slot loaded at power-on), the sample bank (8 slots), the DX7 library (4 banks),
//     the tuning and track roles / input channels;
//   - the plugin's own settings (meta; none yet).
// Version 2, little-endian:
//   "FM1P"  u32 version (2)  u32 metaLength  meta (UTF-8 JSON)  u32 projectLength (4264)  project
//   u32 sessionLength (4272, or 0: none)  session
//   u32 count  then count x { u32 offset, 4096 bytes }   (offsets ascending, inside the flash)
// Version 1 (read too): the same without the session (its PLAY tracks start as the project and the boot leave them).
// At most 131 sectors (~ 540 KiB), far under the host's 8 MiB.

export const STATE_VERSION = 2;
export const STATE_READS = [1, 2];
const MAGIC = 0x50314d46;                              // "FM1P"
export const SECTOR = 4096;
export const FLASH_BYTES = 536576;                     // instrument.h GROOVE_FLASH_BYTES
export const PROJECT_BYTES = 4264;                     // GROOVE_PROJECT_TUNED_BYTES
export const SESSION_BYTES = 4272;                     // fm1_plugin.c struct tutti_session
export const DEFAULT_META = Object.freeze({});

export class StateError extends Error {
  constructor(message) { super(message); this.name = "StateError"; this.code = "state-incompatible"; }
}

// the flash's sectors that hold something -> {offset: Uint8Array(4096)} (copies)
export function flashSectors(flash) {
  const out = {};
  for (let off = 0; off < FLASH_BYTES; off += SECTOR) {
    const s = flash.subarray(off, off + SECTOR);
    if (s.some((b) => b !== 0xFF)) out[off] = s.slice();
  }
  return out;
}
// the sectors into an erased flash
export function restoreSectors(flash, sectors) {
  flash.fill(0xFF);
  for (const off of Object.keys(sectors)) flash.set(sectors[off], +off);
}

export function cleanMeta() { return {}; }

// {project, session (null: none), sectors, meta} -> ArrayBuffer (version 2)
export function packState({ project, session = null, sectors, meta = DEFAULT_META }) {
  if (!(project instanceof Uint8Array) || project.length !== PROJECT_BYTES) throw new Error("the state's project: 4264 bytes");
  if (session !== null && !(session instanceof Uint8Array && session.length === SESSION_BYTES)) throw new Error("the state's session: 4272 bytes");
  const offs = Object.keys(sectors).map(Number).sort((a, b) => a - b);
  const mj = new TextEncoder().encode(JSON.stringify(cleanMeta(meta)));
  const sl = session ? SESSION_BYTES : 0;
  const p0 = 12 + mj.length, s0 = p0 + 4 + PROJECT_BYTES, head = s0 + 4 + sl + 4;
  const buf = new ArrayBuffer(head + offs.length * (4 + SECTOR)), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, STATE_VERSION, true);
  dv.setUint32(8, mj.length, true);
  u8.set(mj, 12);
  dv.setUint32(p0, PROJECT_BYTES, true);
  u8.set(project, p0 + 4);
  dv.setUint32(s0, sl, true);
  if (session) u8.set(session, s0 + 4);
  dv.setUint32(head - 4, offs.length, true);
  offs.forEach((off, i) => {
    const p = head + i * (4 + SECTOR);
    dv.setUint32(p, off, true);
    u8.set(sectors[off], p + 4);
  });
  return buf;
}

// -> {project, session (null: none), sectors: {offset: Uint8Array(4096)}, meta} (copies: the input is never changed);
// StateError otherwise
export function unpackState(buf, version = STATE_VERSION) {
  if (version < STATE_READS[0] || version > STATE_READS[1]) throw new StateError(`state version ${version} not read by this plugin`);
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 16) throw new StateError("not an FM1 Open state");
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new StateError("not an FM1 Open state");
  if (dv.getUint32(4, true) !== version) throw new StateError("state version differs from its header");
  const ml = dv.getUint32(8, true);
  if (ml > 4096 || 12 + ml + 4 > buf.byteLength) throw new StateError("state meta truncated");
  let meta;
  try { meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(u8.subarray(12, 12 + ml))); }
  catch { throw new StateError("state meta is not JSON"); }
  const p0 = 12 + ml;
  if (dv.getUint32(p0, true) !== PROJECT_BYTES || p0 + 4 + PROJECT_BYTES + 4 > buf.byteLength) throw new StateError("state project truncated");
  const project = u8.slice(p0 + 4, p0 + 4 + PROJECT_BYTES);
  let head = p0 + 4 + PROJECT_BYTES + 4, session = null;
  if (version >= 2) {
    const s0 = head - 4, sl = dv.getUint32(s0, true);
    if ((sl !== 0 && sl !== SESSION_BYTES) || s0 + 4 + sl + 4 > buf.byteLength) throw new StateError("state session truncated");
    if (sl) session = u8.slice(s0 + 4, s0 + 4 + sl);
    head = s0 + 4 + sl + 4;
  }
  const n = dv.getUint32(head - 4, true);
  if (buf.byteLength !== head + n * (4 + SECTOR)) throw new StateError("state truncated or padded");
  const sectors = {};
  let last = -1;
  for (let i = 0; i < n; i++) {
    const p = head + i * (4 + SECTOR), off = dv.getUint32(p, true);
    if (off <= last || off % SECTOR || off + SECTOR > FLASH_BYTES) throw new StateError(`state sector at ${off} not in the flash`);
    sectors[off] = u8.slice(p + 4, p + 4 + SECTOR);
    last = off;
  }
  return { project, session, sectors, meta: cleanMeta(meta) };
}

export function stateEquals(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// ---- a device (fm1open.wasm's exports) and a state: how every instance (the page's, a render's, a stem's, the tests')
// starts and gives its state. null state: a new FM1 (the flash erased, the demo sample bank written, as the workbench
// starts). Throws StateError when the project does not import.
export function bootDevice(ex, state, { headless = false, hosted = false, bpm = 0 } = {}) {
  ex.tutti_prepare(headless ? 1 : 0, hosted ? 1 : 0);
  if (bpm) ex.tutti_tempo(bpm);                        // (before the boot: the delay's sync is set with the project)
  if (!state) ex.sim_boot(1);
  else {
    restoreSectors(new Uint8Array(ex.memory.buffer, ex.sim_flash(), FLASH_BYTES), state.sectors);
    ex.sim_boot(0);
    new Uint8Array(ex.memory.buffer, ex.sim_file(), PROJECT_BYTES).set(state.project);
    if (ex.sim_import(PROJECT_BYTES)) throw new StateError("the state's project does not load");
    if (state.session) {                               // (after the project: PLAY tracks as they played)
      new Uint8Array(ex.memory.buffer, ex.tutti_session(), SESSION_BYTES).set(state.session);
      if (ex.tutti_session_apply()) throw new StateError("the state's session does not load");
    }
  }
  // what the boot left in the engine's MIDI queue (a MIDI routing restored from the settings posts a reset: it would
  // stop a transport started before the next block) done now (Simulator.c sim_panic: the queue emptied, all notes off)
  ex.sim_panic();
  return ex;
}
export function deviceState(ex, meta = DEFAULT_META) {
  if (ex.sim_export()) throw new Error("the project could not be exported");
  if (ex.tutti_session_capture()) throw new Error("the live session could not be captured");
  return { project: new Uint8Array(ex.memory.buffer, ex.sim_file(), PROJECT_BYTES).slice(),
           session: new Uint8Array(ex.memory.buffer, ex.tutti_session(), SESSION_BYTES).slice(),
           sectors: flashSectors(new Uint8Array(ex.memory.buffer, ex.sim_flash(), FLASH_BYTES)), meta: { ...meta } };
}
