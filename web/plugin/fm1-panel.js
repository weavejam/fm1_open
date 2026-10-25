// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// A hardware FM-1 through tuttidaw (tutti-plugin/0 section 12, docs/plugins/protocol-v0.md in tuttidaw): while this
// plugin's window has the focus, the host's FM-1 (RemoteFM1) is FM1 Open's panel - its buttons, keys, encoders and
// MASTER go into the device as the page's own controls do (device.js `control`), and the device's screen and LEDs go
// back to the unit. The same messages as Felucca's / JIANT FM's / SLOOP's bridge; FM1 Open's device differs:
//   - inputs: control(kind, index, value) - kind 0 a button by its matrix id (0 OCT-, 1 OCT+, 2 FX .. 13 REC; the
//     protocol's label order is FX .. REC, OCT-, OCT+), 1 a key 0..26, 2 an encoder by its matrix number (0 SELECT,
//     1 ALGORITHM, 2..5 KNOB 1..4, 6 PRESETS) and a delta; MASTER is the page's volume (device.js master);
//   - the screen comes in bands of 16 rows (a frame's pixels + pixelBands, RGB565 values): kept whole here so a
//     `panel-frame` always carries the full 240 x 240; the LEDs are the frame's state[168 + matrix id];
//   - `panel-frame` only while attached, when the screen or the LEDs change, at most 30 a second; detaching lifts what
//     the hardware holds.

export const BUTTONS = ["fx", "scl", "env", "lfo", "edit", "glo", "home", "save", "arp", "seq", "play", "rec",
                        "octDown", "octUp"];
export const ENCODERS = { select: 0, algorithm: 1, knob1: 2, knob2: 3, knob3: 4, knob4: 5, presets: 6 };
export const MAX_EVENTS = 64;
const FRAME_MS = 1000 / 30;
const LED_AT = 168;                                    // device.js: a frame's state[168 + LED id]
const BAND = 240 * 16;

/** A button's matrix id from its label (FX .. REC -> 2 .. 13, OCT- 0, OCT+ 1). */
export function buttonId(name) {
  const b = BUTTONS.indexOf(name);
  return b < 12 ? b + 2 : b - 12;
}

// a frame's state -> the protocol's LED masks (buttons in label order, keys 0..26)
export function panelLeds(state) {
  let buttons = 0, keys = 0;
  BUTTONS.forEach((name, b) => { if (state[LED_AT + buttonId(name)]) buttons |= 1 << b; });
  for (let k = 0; k < 27; k++) if (state[LED_AT + 14 + k]) keys |= 1 << k;
  return { buttons: { lit: buttons >>> 0, dim: 0 }, keys: { lit: keys >>> 0, dim: 0 }, playGreen: false };
}

function valid(e) {
  if (!e || typeof e !== "object") return false;
  if (e.kind === "button") return BUTTONS.includes(e.name) && typeof e.down === "boolean";
  if (e.kind === "key") return Number.isInteger(e.index) && e.index >= 0 && e.index < 27 && typeof e.down === "boolean";
  if (e.kind === "encoder") return e.name in ENCODERS && Number.isInteger(e.steps) && e.steps !== 0 && Math.abs(e.steps) <= 63;
  if (e.kind === "master") return Number.isInteger(e.value) && e.value >= 0 && e.value <= 1023;
  return false;
}

export class PanelBridge {
  // send(msg, transfer): to the host (the session's send); control(kind, index, value): into the device;
  // master(0..1023): the page's volume; now / timers injectable for the tests
  constructor(send, { control, master, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.send = send;
    this.control = control;
    this.master = master;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.attached = false;
    this.held = new Set();                             // "kind:index" the hardware holds
    this.screen = new Uint16Array(240 * 240);
    this.haveScreen = false;
    this.leds = null;
    this.ledKey = "";
    this.dirty = { screen: false, leds: false };
    this.timer = null;
    this.sentAt = -Infinity;
  }

  // a frame from the device (worklet-tutti.js): its changed bands into the whole screen, its LEDs
  frame(m) {
    if (!m || m.type !== "frame") return;
    if (m.pixels && m.pixelBands) {
      for (let band = 0, source = 0; band < 15; band++) {
        if (!(m.pixelBands & (1 << band))) continue;
        this.screen.set(m.pixels.subarray(source, source + BAND), band * BAND);
        source += BAND;
      }
      this.haveScreen = true;
      this.dirty.screen = true;
    }
    if (m.state) {
      const leds = panelLeds(m.state), key = JSON.stringify(leds);
      if (key !== this.ledKey) {
        this.ledKey = key;
        this.leds = leds;
        this.dirty.leds = true;
      }
    }
    this.flush();
  }

  attach(on) {
    if (on === this.attached) return;
    this.attached = on;
    if (on) {
      this.dirty = { screen: this.haveScreen, leds: !!this.leds };
      this.sentAt = -Infinity;
      this.flush();
      return;
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    // whatever the hardware still holds is lifted
    for (const item of this.held) {
      const [kind, index] = item.split(":").map(Number);
      this.control(kind, index, 0);
    }
    this.held.clear();
  }

  events(list) {
    if (!this.attached || !Array.isArray(list) || list.length > MAX_EVENTS) return;
    for (const e of list) {
      if (!valid(e)) continue;
      if (e.kind === "button" || e.kind === "key") {
        const kind = e.kind === "button" ? 0 : 1, index = e.kind === "button" ? buttonId(e.name) : e.index;
        const item = kind + ":" + index;
        if (e.down) this.held.add(item);
        else this.held.delete(item);
        this.control(kind, index, e.down ? 1 : 0);
      } else if (e.kind === "encoder") {
        this.control(2, ENCODERS[e.name], e.steps);
      } else {
        this.master(e.value);
      }
    }
  }

  flush() {
    if (!this.attached || this.timer !== null || !(this.dirty.screen || this.dirty.leds)) return;
    const wait = this.sentAt + FRAME_MS - this.now();
    if (wait > 0) {
      this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, wait);
      return;
    }
    const msg = { type: "panel-frame" }, transfer = [];
    if (this.dirty.screen && this.haveScreen) {
      const copy = this.screen.slice();
      msg.screen = copy.buffer;
      transfer.push(copy.buffer);
    }
    if (this.dirty.leds && this.leds) msg.leds = this.leds;
    this.dirty = { screen: false, leds: false };
    this.sentAt = this.now();
    if (msg.screen || msg.leds) this.send(msg, transfer);
  }
}
