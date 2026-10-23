// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The device on the plugin page: the workbench's FM1 panel (sdk/Simulator.js, its page part: the screen, the LCD's
// click targets and their editor, the encoders, the buttons with their LEDs, the 27 keys, the hold / latch rules, the
// computer keyboard), ported to drive the page's live FM1 Open (worklet-tutti.js) instead of the workbench's own copy.
// Its text is the workbench's (sdk/I18n.js translates it: English by default, 简体中文 with ?lang=zh-CN). Derived from
// sdk/Simulator.js, FM1 Open (GPL-3.0-only WITH GPL-3.0-linking-exception), here under GPL-3.0-only.
//   createDevice({ root, send(type, args), request(type, args) -> Promise, say(text), start() })
//   -> { receive(frame), setReady(on), release(), state() }
const T = (node, text) => globalThis.FM1I18n.text(node, text);
const A = (node, name, text) => globalThis.FM1I18n.attr(node, name, text);
export const SOURCES = ["DX7", "303", "808", "PSG", "PLUCK", "SAMPLER"];

export function createDevice({ root, send, request, say, start = () => {} }) {
  const $ = (id) => root.querySelector("#" + id);
  root.innerHTML = `
<div class="device-brand">FM1 <span>OPEN</span></div><span class="case-mark">8 TRACKS · 6 ENGINES</span>
<i class="screw tl"></i><i class="screw tr"></i><i class="screw bl"></i><i class="screw br"></i>
<div class="screen-bezel"><div class="lcd-surface"><canvas id="sim-screen" width="240" height="240" aria-label="FM1 设备屏幕仿真"></canvas><div id="sim-lcd-targets" aria-label="LCD 点击编辑"></div></div><div id="sim-placeholder" class="screen-placeholder"><strong>FM1</strong>正在载入面板…</div></div>
<div class="screen-caption"><span>8 TRACKS / 64 STEPS</span><span>6 ENGINES</span></div>
<div id="sim-keyboard" class="keyboard" aria-label="27 键演奏与步进键盘"></div>`;
  globalThis.FM1I18n.scan(root);
  const dialog = document.createElement("dialog");
  dialog.id = "sim-lcd-dialog";
  dialog.className = "save-dialog lcd-editor";
  dialog.innerHTML = `<h2>LCD 参数编辑</h2><h3 id="sim-lcd-label"></h3><div id="sim-lcd-value" class="lcd-value"></div>
<div class="lcd-adjust"><button id="sim-lcd-minus" aria-label="减少参数">−</button><button id="sim-lcd-plus" aria-label="增加参数">＋</button></div>
<button id="sim-lcd-close">完成</button>`;
  document.body.append(dialog);
  globalThis.FM1I18n.scan(dialog);
  const dq = (id) => dialog.querySelector("#" + id);

  let state, ready = false;
  const image = $("sim-screen").getContext("2d"), pixels = image.createImageData(240, 240);
  const rgb5 = new Uint8ClampedArray(32), rgb6 = new Uint8ClampedArray(64);
  for (let i = 0; i < 32; i++) rgb5[i] = i * 255 / 31;
  for (let i = 0; i < 64; i++) rgb6[i] = i * 255 / 63;
  for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;

  // ---- the LCD: click targets over the screen, a dialog to edit a value (wheel, + / -, arrows)
  let lcdKey = "", lcdScreen, lcdEditing, lcdItems = new Map(), lcdReturnFocus;
  const lcdId = (item) => [item.action, item.index, item.owner].join(":");
  function lcdAdjust(item, delta) {
    if (!item || !ready) return;
    send("lcd", { context: lcdScreen.context, action: item.action, index: item.index, owner: item.owner, delta });
  }
  // trackpads report many small pixel deltas, wheel notches large ones: one fine step per notch, small movements
  // accumulated; browser zoom (Ctrl / Meta + wheel) untouched
  function lcdWheel(button, getItem) {
    let amount = 0, last = 0, direction = 0, context;
    const reset = () => { amount = last = direction = 0; };
    button.addEventListener("pointerleave", reset);
    button.addEventListener("wheel", (event) => {
      const item = getItem();
      if (button.disabled || !item || !event.deltaY || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now(), sign = Math.sign(event.deltaY);
      const nextContext = lcdScreen.context + ":" + lcdId(item);
      if (nextContext !== context) { reset(); context = nextContext; }
      if (sign !== direction || now - last > 250) { amount = 0; direction = sign; }
      last = now;
      amount += Math.abs(event.deltaY);
      if (event.deltaMode || amount >= 40) { amount = 0; lcdAdjust(item, -sign); }
    }, { passive: false });
  }
  function lcdValue() {
    const item = lcdItems.get(lcdEditing);
    if (!item) return;
    if (dq("sim-lcd-label").textContent !== item.label) dq("sim-lcd-label").textContent = item.label;
    if (dq("sim-lcd-value").textContent !== item.value) dq("sim-lcd-value").textContent = item.value;
  }
  function editLcd(id, button) { release(); lcdEditing = id; lcdReturnFocus = button; lcdValue(); dialog.showModal(); dq("sim-lcd-plus").focus(); }
  function closeLcd() { dialog.close(); if (lcdReturnFocus && lcdReturnFocus.isConnected) lcdReturnFocus.focus(); }
  dq("sim-lcd-close").onclick = closeLcd;
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeLcd(); });
  dq("sim-lcd-minus").onclick = () => lcdAdjust(lcdItems.get(lcdEditing), -1);
  dq("sim-lcd-plus").onclick = () => lcdAdjust(lcdItems.get(lcdEditing), 1);
  lcdWheel(dq("sim-lcd-value"), () => dialog.open && lcdItems.get(lcdEditing));
  dialog.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.code)) {
      event.preventDefault();
      event.stopPropagation();
      lcdAdjust(lcdItems.get(lcdEditing), ["ArrowLeft", "ArrowDown"].includes(event.code) ? -1 : 1);
    }
  });
  async function action(fn) { try { await fn(); } catch (error) { say(error.message); } }
  async function select(track, source) { await request("select", { track, source }); }
  function updateScreenControls(screen, contextChanged) {
    if (!screen) return;
    const changed = contextChanged || (lcdScreen && lcdScreen.context) !== screen.context;
    lcdScreen = screen;
    if (changed && dialog.open) closeLcd();
    const items = screen.targets.slice();
    for (let col = 0; col < 4; col++) if (screen.mask & (1 << col)) {
      const [label, value] = screen.knobs[col];
      items.push({ rect: [6 + 59 * col, 195, 54, 32], action: 0, index: col, owner: state[0], label, value, knob: col });
    }
    lcdItems = new Map(items.map((item) => [lcdId(item), item]));
    if (dialog.open) { if (lcdItems.has(lcdEditing)) lcdValue(); else closeLcd(); }
    const lengths = state[1] === 0 ? state.subarray(209, 217).join(",") : state[209 + state[0]];
    const key = screen.context + ":" + screen.first + ":" + lengths + ":" + items.map((item) => [lcdId(item), ...item.rect].join(",")).join(";");
    const host = $("sim-lcd-targets");
    if (key !== lcdKey) {
      lcdKey = key;
      host.replaceChildren();
      const target = (x, y, w, h, label, fn) => {
        const button = document.createElement("button");
        button.className = "lcd-target";
        Object.assign(button.style, { left: x / 2.4 + "%", top: y / 2.4 + "%", width: w / 2.4 + "%", height: h / 2.4 + "%" });
        A(button, "aria-label", label);
        A(button, "title", label);
        button.onclick = () => action(fn);
        host.append(button);
        return button;
      };
      if (state[1] === 0) {
        for (let t = 0; t < 8; t++) {
          target(5, 48 + t * 18, 72, 16, "轨道 " + (t + 1), () => select(t, 6));
          for (let i = 0; i < 16; i++) {
            const step = screen.first + i;
            if (step >= state[209 + t]) continue;
            target(80 + i * 8, 48 + t * 18, 8, 16, "T" + (t + 1) + " / STEP " + (step + 1), async () => { await select(t, 6); await request("step", { index: step }); }).tabIndex = -1;
          }
        }
      } else if (state[1] === 1) {
        const length = state[209 + state[0]];
        for (let p = 0; p < 4; p++) if (p * 16 < length) target(8 + p * 57, 50, 53, 14, "PAGE " + (p + 1), () => request("step", { index: p * 16 }));
        for (let i = 0; i < 16; i++) {
          const step = screen.first + i;
          if (step >= length) continue;
          const cell = target(8 + (i % 4) * 57, 72 + Math.floor(i / 4) * 29, 53, 25, "STEP " + (step + 1), () => request("step", { index: step, toggle: true }));
          cell.dataset.lcdStep = step;
          cell.addEventListener("keydown", (event) => {
            const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[event.code];
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            const next = Math.max(screen.first, Math.min(screen.first + 15, length - 1, step + delta));
            const el = host.querySelector('[data-lcd-step="' + next + '"]');
            if (el) el.focus();
          });
        }
      }
      for (const item of items) {
        const id = lcdId(item), button = target(...item.rect, item.label, () => editLcd(id, button));
        button.dataset.lcdEdit = id;
        if (item.knob !== undefined) button.dataset.lcdKnob = item.knob;
        lcdWheel(button, () => lcdItems.get(id));
        button.addEventListener("keydown", (event) => {
          const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.code];
          if (delta) { event.preventDefault(); event.stopPropagation(); lcdAdjust(lcdItems.get(id), delta); }
        });
      }
    }
    for (const cell of host.querySelectorAll("[data-lcd-step]")) cell.tabIndex = Number(cell.dataset.lcdStep) === state[2] ? 0 : -1;
    for (const button of host.querySelectorAll("[data-lcd-edit]")) {
      const item = lcdItems.get(button.dataset.lcdEdit);
      button.disabled = !ready || !item;
      if (!item) continue;
      const description = (button.dataset.lcdKnob !== undefined ? "K" + (Number(button.dataset.lcdKnob) + 1) + " / " : "") + item.label + " / " + item.value;
      if (button.getAttribute("aria-label") !== description) { button.setAttribute("aria-label", description); button.title = description; }
    }
  }

  // ---- the panel: held controls (pointer, keys, focus), latches (Shift-click / right-click a button), short pulses
  const holders = new Map(), latched = new Set(), pulseTimers = new Map();
  let held = new Set();
  const control = (kind, index, value) => send("control", { kind, index, value });
  function syncHolds() {
    const next = new Set(latched);
    for (const item of holders.values()) next.add(item);
    for (const item of held) if (!next.has(item)) { const [kind, index] = item.split(":").map(Number); control(kind, index, 0); }
    for (const item of next) if (!held.has(item)) { const [kind, index] = item.split(":").map(Number); control(kind, index, 1); }
    held = next;
    for (const element of root.querySelectorAll("[data-hold]")) {
      element.classList.toggle("held", held.has(element.dataset.hold));
      element.classList.toggle("latched", latched.has(element.dataset.hold));
      element.setAttribute("aria-pressed", String(held.has(element.dataset.hold)));
    }
  }
  function release() {
    for (const timer of pulseTimers.values()) clearTimeout(timer);
    pulseTimers.clear();
    holders.clear();
    latched.clear();
    held.clear();
    send("release");
    for (const e of root.querySelectorAll("[data-hold]")) { e.classList.remove("held", "latched"); e.setAttribute("aria-pressed", "false"); }
  }
  function latch(item) { if (latched.has(item)) latched.delete(item); else latched.add(item); syncHolds(); }
  function pulse(kind, index) {
    const owner = "click:" + kind + ":" + index;
    clearTimeout(pulseTimers.get(owner));
    if (holders.delete(owner)) syncHolds();
    holders.set(owner, kind + ":" + index);
    syncHolds();
    pulseTimers.set(owner, setTimeout(() => { pulseTimers.delete(owner); holders.delete(owner); syncHolds(); }, kind === 1 ? 100 : 55));
  }
  function hold(element, kind, index) {
    const item = kind + ":" + index;
    element.dataset.hold = item;
    element.addEventListener("contextmenu", (e) => e.preventDefault());
    element.addEventListener("pointerdown", (event) => {
      if (element.disabled || (event.button !== 0 && !(kind === 0 && event.button === 2))) return;
      event.preventDefault();
      start();
      if (kind === 0 && (event.shiftKey || event.button === 2 || latched.has(item))) { latch(item); return; }
      element.setPointerCapture(event.pointerId);
      holders.set("pointer:" + event.pointerId, item);
      syncHolds();
    });
    const up = (event) => { if (holders.delete("pointer:" + event.pointerId)) syncHolds(); };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) element.addEventListener(type, up);
    element.addEventListener("keydown", (event) => {
      if (!element.disabled && ["Enter", "Space"].includes(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (kind === 0 && (event.shiftKey || latched.has(item))) latch(item);
          else { holders.set("focus:" + event.code, item); syncHolds(); }
        }
      }
    });
    element.addEventListener("blur", () => {
      let changed = false;
      for (const code of ["Enter", "Space"]) if (holders.get("focus:" + code) === item) { holders.delete("focus:" + code); changed = true; }
      if (changed) syncHolds();
    });
    // accessibility actions and keyboard-generated clicks may not emit pointer events
    element.addEventListener("click", (event) => {
      if (event.detail === 0 && !element.disabled) { if (kind === 0 && (event.shiftKey || latched.has(item))) latch(item); else pulse(kind, index); }
    });
  }

  // ---- the controls, where the FM1's faceplate has them (sdk/Simulator.js buildControls)
  const encoders = [["MASTER", -1, 105, 100], ["SELECT", 0, 215, 100], ["PRESETS", 6, 105, 205], ["ALGORITHM", 1, 215, 205],
                    ["KNOB 1", 2, 610, 100], ["KNOB 2", 3, 714, 100], ["KNOB 3", 4, 818, 100], ["KNOB 4", 5, 922, 100]];
  let volume = 100, onVolume = () => {};
  const master = { set(v) { volume = Math.max(0, Math.min(100, v)); const d = root.querySelector("[data-encoder='-1']"); if (d) { d.style.setProperty("--angle", (-135 + volume * 2.7) + "deg"); d.setAttribute("aria-valuenow", String(volume)); } onVolume(volume); } };
  for (const [label, index, x, y] of encoders) {
    const box = document.createElement("div");
    box.className = "encoder";
    box.style.left = (x / 10) + "%";
    box.style.top = (y / 6.24) + "%";
    box.innerHTML = '<span>' + label + '</span><button class="dial" data-sim disabled aria-label="' + label + '：拖动、滚轮或点击调节"><i></i></button><div class="detents"><button data-sim disabled aria-label="' + label + ' 减少">−</button><button data-sim disabled aria-label="' + label + ' 增加">＋</button></div>';
    const dial = box.querySelector(".dial"), buttons = box.lastElementChild.querySelectorAll("button");
    dial.dataset.encoder = index;
    if (index < 0) { dial.setAttribute("role", "slider"); dial.setAttribute("aria-valuemin", "0"); dial.setAttribute("aria-valuemax", "100"); }
    let angle = 0, lastY = 0, moved = false;
    const turn = (delta) => {
      if (!ready) return;
      if (index < 0) master.set(volume + delta * 2);
      else { angle += delta * 18; dial.style.setProperty("--angle", angle + "deg"); control(2, index, delta); }
    };
    buttons[0].onclick = () => turn(-1);
    buttons[1].onclick = () => turn(1);
    dial.addEventListener("wheel", (event) => {
      if (dial.disabled || !event.deltaY || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      turn(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    dial.addEventListener("pointerdown", (event) => { if (dial.disabled || event.button !== 0) return; event.preventDefault(); start(); lastY = event.clientY; moved = false; dial.setPointerCapture(event.pointerId); });
    dial.addEventListener("pointermove", (event) => {
      if (!dial.hasPointerCapture(event.pointerId)) return;
      const delta = Math.trunc((lastY - event.clientY) / 6);
      if (delta) { moved = true; lastY -= delta * 6; turn(Math.max(-20, Math.min(20, delta))); }
    });
    dial.addEventListener("pointerup", (event) => { if (dial.hasPointerCapture(event.pointerId) && !moved) turn(event.shiftKey ? -1 : 1); });
    dial.addEventListener("click", (event) => { if (event.detail === 0) turn(event.shiftKey ? -1 : 1); });
    dial.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        turn(event.code === "ArrowUp" || event.code === "ArrowRight" ? 1 : -1);
      }
    });
    globalThis.FM1I18n.scan(box);
    root.append(box);
  }
  const buttons = [["OCT −", 0, 60, 258, 90, 34], ["OCT ＋", 1, 170, 258, 90, 34]];
  ["FX", "SEL", "ENV", "LFO", "EDIT", "GLO"].forEach((n, i) => buttons.push([n, 2 + i, 582 + i * 63, 174, 54, 48]));
  ["HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"].forEach((n, i) => buttons.push([n, 8 + i, 582 + i * 63, 236, 54, 48]));
  for (const [label, id, x, y, w, h] of buttons) {
    const button = document.createElement("button");
    if (id !== 12) T(button, label);
    button.className = "panel-button";
    button.dataset.sim = "";
    button.dataset.led = id;
    button.dataset.button = id;
    button.disabled = true;
    Object.assign(button.style, { left: x / 10 + "%", top: y / 6.24 + "%", width: w / 10 + "%", height: h / 6.24 + "%" });
    A(button, "title", label + "（Shift 点击或右击可锁定按住）");
    if (id === 12) button.innerHTML = "PLAY<small>STOP</small>";
    hold(button, 0, id);
    root.append(button);
  }
  const whites = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26], edits = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22];
  const names = ["OP1", "OP2", "OP3", "OP4", "OP5", "OP6", "PITCH", "GLOBAL", "MONO", "POLY"];
  for (let key = 0; key < 27; key++) {
    const white = whites.indexOf(key), button = document.createElement("button");
    button.className = "piano-key " + (white >= 0 ? "white" : "black");
    button.dataset.sim = "";
    button.dataset.led = key + 14;
    button.dataset.key = key;
    button.disabled = true;
    const center = white >= 0 ? white + .5 : whites.filter((k) => k < key).length;
    button.style.left = (center * 100 / 16) + "%";
    button.innerHTML = "<i></i><span>" + (white >= 0 ? String(white + 1).padStart(2, "0") : names[edits.indexOf(key)] || "") + "</span>";
    A(button, "aria-label", white >= 0 ? "音符／步 " + (white + 1) : names[edits.indexOf(key)] || "升音键");
    hold(button, 1, key);
    $("sim-keyboard").append(button);
  }
  const leds = Array.from(root.querySelectorAll("[data-led]"), (button) => [button, 168 + Number(button.dataset.led)]);

  // ---- the computer keyboard: the 27 keys (Z S X D C ... as the workbench maps them), Space PLAY, Escape all off
  const keyCodes = ["KeyZ", "KeyS", "KeyX", "KeyD", "KeyC", "KeyF", "KeyV", "KeyB", "KeyH", "KeyN", "KeyJ", "KeyM", "Comma", "KeyL", "Period", "Semicolon", "Slash", "Quote", "KeyQ", "Digit2", "KeyW", "Digit3", "KeyE", "KeyR", "Digit5", "KeyT", "Digit6"];
  window.addEventListener("keydown", (event) => {
    if (!ready || document.hidden || document.querySelector("dialog[open]")) return;
    if (event.code === "Escape") { release(); send("panic"); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|SELECT|TEXTAREA|SUMMARY|^A$/.test(event.target.tagName)) return;
    if (event.code === "Space") { if (event.target.tagName === "BUTTON") return; event.preventDefault(); start(); if (!event.repeat) { control(0, 12, 1); control(0, 12, 0); } return; }
    const index = keyCodes.indexOf(event.code);
    if (index < 0) return;
    event.preventDefault();
    start();
    if (!event.repeat) { holders.set("keyboard:" + event.code, "1:" + index); syncHolds(); }
  });
  window.addEventListener("keyup", (event) => {
    const keyboard = holders.delete("keyboard:" + event.code), focus = holders.delete("focus:" + event.code);
    if (keyboard || focus) { event.preventDefault(); syncHolds(); }
  });
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });

  // ---- a frame from the device (worklet-tutti.js frame)
  function receive(message) {
    const before = state;
    state = message.state;
    const contextChanged = !before || before[1] !== state[1] || before[0] !== state[0] || before[8 + before[0] * 20] !== state[8 + state[0] * 20];
    updateScreenControls(message.screen, contextChanged);
    if (message.pixels) for (let band = 0, source = 0; band < 15;) {
      if (!(message.pixelBands & (1 << band))) { band++; continue; }
      const first = band;
      while (band < 15 && (message.pixelBands & (1 << band))) band++;
      for (let i = first * 3840; i < band * 3840; i++) {
        const value = message.pixels[source++], at = i * 4;
        pixels.data[at] = rgb5[value >> 11];
        pixels.data[at + 1] = rgb6[(value >> 5) & 63];
        pixels.data[at + 2] = rgb5[value & 31];
      }
      image.putImageData(pixels, 0, 0, 0, first * 16, 240, (band - first) * 16);
    }
    for (const [button, at] of leds) if (!before || before[at] !== state[at]) button.classList.toggle("lit", !!state[at]);
  }
  function setReady(on) {
    ready = on;
    for (const element of root.querySelectorAll("[data-sim]")) element.disabled = !on;
    $("sim-placeholder").hidden = on;
  }
  return { receive, setReady, release, master, onVolume: (fn) => { onVolume = fn; }, state: () => state };
}
