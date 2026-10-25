// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The hardware FM-1 bridge (fm1-panel.js) and its messages (protocol.js, protocol 12): node web/plugin/fm1_panel_test.mjs
import assert from "node:assert/strict";
import { PanelBridge, panelLeds, buttonId, BUTTONS, ENCODERS } from "./fm1-panel.js";
import { PluginSession } from "./protocol.js";

const BAND = 240 * 16;
function rig() {
  const sent = [], controls = [], masters = [], timers = [];
  let t = 1000;
  const bridge = new PanelBridge((m, transfer) => sent.push({ m, transfer }), {
    control: (kind, index, value) => controls.push([kind, index, value]),
    master: (v) => masters.push(v),
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
  });
  return { bridge, sent, controls, masters, timers, advance: (ms) => { t += ms; } };
}
const frame = (bands, fill, state = new Uint8Array(256)) => {
  let n = 0;
  for (let b = 0; b < 15; b++) if (bands & (1 << b)) n++;
  return { type: "frame", pixelBands: bands, pixels: new Uint16Array(n * BAND).fill(fill), state };
};

// the label order -> the matrix ids (FX .. REC 2..13, OCT- 0, OCT+ 1)
assert.deepEqual(BUTTONS.map(buttonId), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 1]);
assert.deepEqual(ENCODERS, { select: 0, algorithm: 1, knob1: 2, knob2: 3, knob3: 4, knob4: 5, presets: 6 });

// the LEDs: state[168 + matrix id], keys from 168 + 14
{
  const s = new Uint8Array(256);
  s[168 + 2] = 1;                                        // FX
  s[168 + 0] = 3;                                        // OCT-
  s[168 + 14] = 1;                                       // key 0
  s[168 + 14 + 26] = 2;                                  // key 26
  const l = panelLeds(s);
  assert.equal(l.buttons.lit, (1 << 0) | (1 << 12));
  assert.equal(l.keys.lit, 1 | (1 << 26));
  assert.equal(l.playGreen, false);
}

// inputs: nothing until attached; buttons / keys / encoders into control, MASTER into the volume
{
  const r = rig();
  r.bridge.events([{ kind: "key", index: 0, down: true }]);
  assert.equal(r.controls.length, 0);
  r.bridge.attach(true);
  r.bridge.events([
    { kind: "button", name: "play", down: true }, { kind: "button", name: "play", down: false },
    { kind: "button", name: "octUp", down: true },
    { kind: "key", index: 26, down: true },
    { kind: "encoder", name: "presets", steps: -2 }, { kind: "encoder", name: "knob1", steps: 3 },
    { kind: "master", value: 1023 },
    { kind: "key", index: 27, down: true }, { kind: "encoder", name: "nope", steps: 1 }, { kind: "button", name: "x", down: true },
  ]);
  assert.deepEqual(r.controls, [[0, 12, 1], [0, 12, 0], [0, 1, 1], [1, 26, 1], [2, 6, -2], [2, 2, 3]]);
  assert.deepEqual(r.masters, [1023]);
  // detaching lifts what the hardware holds (OCT+, key 26), not what it let go
  r.controls.length = 0;
  r.bridge.attach(false);
  assert.deepEqual(r.controls.sort(), [[0, 1, 0], [1, 26, 0]]);
  r.bridge.events([{ kind: "key", index: 1, down: true }]);
  assert.equal(r.controls.length, 2);
  r.bridge.attach(true);
  r.bridge.events(Array.from({ length: 65 }, () => ({ kind: "key", index: 1, down: true })));   // (too many: dropped)
  assert.equal(r.controls.length, 2);
}

// the screen: changed bands merged into the whole, sent whole; LEDs only when they change; 30 a second at most
{
  const r = rig();
  r.bridge.frame(frame(0x7fff, 0x1111));                // (before attaching: kept, not sent)
  assert.equal(r.sent.length, 0);
  r.bridge.attach(true);
  assert.equal(r.sent.length, 1);
  const first = new Uint16Array(r.sent[0].m.screen);
  assert.equal(first.length, 240 * 240);
  assert.ok(first.every((v) => v === 0x1111));
  assert.deepEqual(r.sent[0].transfer, [r.sent[0].m.screen]);
  assert.equal(r.sent[0].m.leds.buttons.lit, 0);

  r.advance(40);
  r.bridge.frame(frame((1 << 2) | (1 << 14), 0xf800));   // bands 2 and 14
  assert.equal(r.sent.length, 2);
  const two = new Uint16Array(r.sent[1].m.screen);
  assert.equal(two[2 * BAND - 1], 0x1111);
  assert.equal(two[2 * BAND], 0xf800);
  assert.equal(two[3 * BAND - 1], 0xf800);
  assert.equal(two[3 * BAND], 0x1111);
  assert.equal(two[14 * BAND], 0xf800);
  assert.equal(two[240 * 240 - 1], 0xf800);
  assert.equal(r.sent[1].m.leds, undefined);             // (the LEDs did not change)

  r.advance(10);                                         // (too soon: one timer, then the latest)
  const s = new Uint8Array(256);
  s[168 + 12] = 1;                                       // PLAY
  r.bridge.frame({ type: "frame", state: s });
  r.bridge.frame({ type: "frame", state: s });
  assert.equal(r.sent.length, 2);
  assert.equal(r.timers.filter(Boolean).length, 1);
  r.advance(30);
  r.timers[0].fn();
  assert.equal(r.sent.length, 3);
  assert.equal(r.sent[2].m.screen, undefined);
  assert.equal(r.sent[2].m.leds.buttons.lit, 1 << 10);   // (PLAY is label 10)

  r.advance(40);
  r.bridge.attach(false);
  r.bridge.frame(frame(1, 0));
  assert.equal(r.sent.length, 3);                        // (detached: nothing)
}

// the session: panel-attach / panel to the bridge, close detaches
{
  const calls = [];
  const panel = { attach: (on) => calls.push(["attach", on]), events: (list) => calls.push(["events", list.length]) };
  const engine = { close() {} };
  const session = new PluginSession({ engine, post: () => {}, plugin: { id: "fm1open", version: "0", build: "t" }, panel });
  session.id = "s";
  session.inited = true;
  await session.onPort({ type: "panel-attach", sessionId: "s", attached: true });
  await session.onPort({ type: "panel", sessionId: "s", events: [{ kind: "key", index: 0, down: true }] });
  await session.onPort({ type: "panel-attach", sessionId: "s", attached: "yes" });
  await session.onPort({ type: "panel", sessionId: "s", events: "no" });
  session.close();
  assert.deepEqual(calls, [["attach", true], ["events", 1], ["attach", false]]);
}

console.log("fm1 panel: ok");
