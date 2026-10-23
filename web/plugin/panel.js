// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The companion panel of the plugin page (beside the device in a wide frame, under it in a tall one; tutti.js layout):
// the workbench's parts around its device (sdk/Update.html.in, sdk/Simulator.js), as one column:
//   - the project: its name, edited or not; the 16 factory projects (load one); the current track and its engine;
//   - the eight track lanes (the workbench's "8 track status", sdk/Simulator.js track tiles): engine, level, mute /
//     solo, the 64 steps with the loop length and the playhead; a click selects the track;
//   - the edit pages (the workbench's shortcuts: sound, steps, mix, FX, envelope, LFO, arp, ...);
//   - the sample slots (the workbench's sample page, sdk/Samples.js: a WAV into a slot, a slot emptied, the demo bank);
//   - files: a project (.fm1), a track's timbre (.fm1t) or a DX7 voice (.syx) into the device; the project out.
// Everything goes to the page's FM1 Open as the workbench's operations (worklet-tutti.js command).
import { SOURCES } from "./device.js";
import * as S from "./samples.js";

const T = (node, text) => globalThis.FM1I18n.text(node, text);

export function createPanel({ root, send, request, say, encode, save, start }) {
  root.innerHTML = `
<section class="tt-project">
  <div class="tt-row"><small>当前工程</small><strong id="tt-project-name">…</strong><span id="tt-project-note"></span></div>
  <div class="tt-row"><select id="tt-factory" data-sim disabled aria-label="选择内置预设，选择后载入"></select><button id="tt-factory-load" data-sim disabled>载入所选</button></div>
  <div class="tt-row"><label>当前轨道 <select id="tt-track" data-sim disabled></select></label><label>音源类型 <select id="tt-source" data-sim disabled></select></label></div>
</section>
<section class="tt-lanes" id="tt-lanes" aria-label="八轨步进状态"></section>
<section class="tt-pages">
  <button data-sim data-page="15" disabled>当前轨音色</button><button data-sim data-page="1" disabled>步进编曲</button><button data-sim data-page="6" disabled>混音</button><button data-sim data-page="10" disabled>轨道效果</button>
  <button data-sim data-page="0" disabled>总览</button><button data-sim data-page="3" disabled>包络</button><button data-sim data-page="4" disabled>LFO</button><button data-sim data-page="17" disabled>琶音参数</button>
  <button data-sim data-page="2" disabled>完整音色编辑</button><button data-sim data-page="13" disabled>步进细节</button><button data-sim data-page="14" disabled>节奏与录入</button><button data-sim data-page="12" disabled>复制与更多</button>
</section>
<details class="tt-more" id="tt-samples-box"><summary>8 槽采样库</summary>
  <p id="tt-sample-space" class="tt-help"></p>
  <div class="tt-row"><select id="tt-sample-slot" data-sim disabled aria-label="采样槽"></select><input id="tt-sample-name" maxlength="15" data-sim disabled aria-label="名称（最多 15 个英文字符）" placeholder="SAMPLE"></div>
  <div class="tt-row"><label class="tt-file">WAV 音频 <input id="tt-sample-wav" type="file" accept=".wav,audio/wav" data-sim disabled></label></div>
  <div class="tt-row"><button id="tt-sample-empty" data-sim disabled>清空网页槽位</button><button id="tt-sample-factory" data-sim disabled>载入内置采样库</button></div>
</details>
<details class="tt-more"><summary>文件</summary>
  <div class="tt-row"><label class="tt-file">导入仿真项目或音色 <input id="tt-file" type="file" accept=".fm1,.fm1t,.syx" data-sim disabled></label></div>
  <div class="tt-row"><select id="tt-voice" hidden aria-label="选择音色库中的音色"></select><button id="tt-file-apply" data-sim disabled>导入到仿真</button></div>
  <div class="tt-row"><button id="tt-project-export" data-sim disabled>导出项目文件</button><button id="tt-timbre-export" data-sim disabled>导出轨道音色</button></div>
</details>`;
  globalThis.FM1I18n.scan(root);
  const $ = (id) => root.querySelector("#" + id);
  let state, ready = false, entries = null, selected = null, voices = [], factoryNames = [];

  // ---- the lanes
  const lanes = [];
  for (let t = 0; t < 8; t++) {
    const lane = document.createElement("button");
    lane.className = "tt-lane";
    lane.dataset.sim = "";
    lane.disabled = true;
    lane.innerHTML = `<span class="tt-num">T${t + 1}</span><span class="tt-eng"></span><span class="tt-flags"><i class="m">M</i><i class="s">S</i></span>` +
                     `<span class="tt-meter"><i></i></span><span class="tt-steps">${"<i></i>".repeat(64)}</span>`;
    lane.addEventListener("click", () => action(() => request("select", { track: t, source: 6 })));
    $("tt-lanes").append(lane);
    lanes.push({ lane, eng: lane.querySelector(".tt-eng"), meter: lane.querySelector(".tt-meter i"), dots: lane.querySelectorAll(".tt-steps i") });
    const o = document.createElement("option");
    o.value = t;
    T(o, "轨道 " + (t + 1));
    $("tt-track").append(o);
  }
  SOURCES.forEach((name, type) => { const o = document.createElement("option"); o.value = type; o.textContent = name; $("tt-source").append(o); });
  async function action(fn) { try { await fn(); } catch (error) { say(error.message); } }

  $("tt-track").onchange = () => action(() => request("select", { track: +$("tt-track").value, source: 6 }));
  $("tt-source").onchange = () => action(async () => {
    const track = +$("tt-track").value, source = +$("tt-source").value;
    if (confirm(globalThis.FM1I18n.t("切换音源将重置此轨的音色；鼓与旋律之间切换还会清空此轨步进。继续吗？"))) await request("select", { track, source });
    else $("tt-source").value = String(state[8 + track * 20]);
  });
  for (const b of root.querySelectorAll("[data-page]")) b.onclick = () => action(async () => { start(); await request("open", { page: +b.dataset.page }); });
  const loadFactory = () => action(async () => {
    const i = +$("tt-factory").value;
    if (!(i >= 0)) return;
    await request("preset", { index: i });
    say("已载入 " + $("tt-factory").selectedOptions[0].textContent + "。");
  });
  $("tt-factory").onchange = loadFactory;
  $("tt-factory-load").onclick = loadFactory;

  // ---- samples (sdk/Samples.js: a WAV decoded at 32 kHz, mixed to mono, SEA5-coded, into the bank, the bank into the
  // device's flash)
  async function bank() {
    entries = S.read(await request("sample-bank"));
    const slot = $("tt-sample-slot"), old = slot.value;
    slot.replaceChildren();
    entries.forEach((s, i) => { const o = document.createElement("option"); o.value = i; T(o, (i + 1) + " · " + (s.name || "空槽") + " · " + (s.frames / S.RATE).toFixed(2) + " 秒"); slot.append(o); });
    slot.value = old || "0";
    const used = S.HEADER + entries.reduce((n, s) => n + s.data.length, 0);
    T($("tt-sample-space"), "已用 " + ((used - S.HEADER) / 1024).toFixed(1) + " / " + ((S.CAPACITY - S.HEADER) / 1024).toFixed(1) + " KiB；余 " +
      (Math.max(0, Math.floor((S.CAPACITY - used) / S.CHUNK_BYTES)) * S.CHUNK_FRAMES / S.RATE).toFixed(2) + " 秒（按 SEA5 估算）。");
  }
  $("tt-samples-box").addEventListener("toggle", () => { if ($("tt-samples-box").open && ready) action(bank); });
  $("tt-sample-wav").onchange = () => action(async () => {
    const f = $("tt-sample-wav").files[0];
    $("tt-sample-wav").value = "";
    if (!f) return;
    if (!entries) await bank();
    const data = await f.arrayBuffer();
    S.wavInfo(data);
    const ctx = new OfflineAudioContext(1, 1, S.RATE);
    let decoded;
    try { decoded = await ctx.decodeAudioData(data); } catch { throw Error("无法解码 WAV，请导出 PCM 或 32 位浮点 WAV 后重试"); }
    const slot = +$("tt-sample-slot").value, n = Math.min(decoded.length, S.availableFrames(entries, slot));
    if (n <= 0) throw Error("空间不足：请缩短选段或清空其他槽位");
    const ch = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)), pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const x of ch) v += x[i] / ch.length;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
    }
    say("正在编码采样…");
    const next = entries.slice();
    next[slot] = { name: $("tt-sample-name").value || f.name.replace(/\.wav$/i, "").replace(/[^\x20-\x7e]/g, "_").slice(0, 15) || "SAMPLE", frames: n, data: await encode(pcm) };
    await request("samples", { data: S.pack(next) });
    await bank();
    say("已送入仿真；请选择采样器轨道演奏。");
  });
  $("tt-sample-empty").onclick = () => action(async () => {
    if (!entries) await bank();
    const slot = +$("tt-sample-slot").value;
    if (!confirm(globalThis.FM1I18n.t("清空网页采样库槽 " + (slot + 1) + "？写入设备前仍不会修改实机。"))) return;
    const next = entries.slice();
    next[slot] = { name: "", frames: 0, data: new Uint8Array() };
    await request("samples", { data: S.pack(next) });
    await bank();
    say("网页槽位已清空。");
  });
  $("tt-sample-factory").onclick = () => action(async () => {
    if (!confirm(globalThis.FM1I18n.t("用 8 个内置音色替换网页采样库？设备暂不修改。"))) return;
    await request("samples", { data: await request("factory-bank") });
    await bank();
    say("内置采样已载入网页，可写入设备恢复。");
  });

  // ---- files (sdk/Simulator.js's file row)
  $("tt-file").onchange = () => action(async () => {
    selected = undefined;
    voices = [];
    $("tt-voice").replaceChildren();
    $("tt-voice").hidden = true;
    const file = $("tt-file").files[0];
    enable();
    if (!file) return;
    if (file.size > 4280) throw Error("请选择 .fm1 项目、.fm1t 音色或 DX7 .syx 文件");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 240) {
      voices = globalThis.FM1Web.readVoices(bytes);
      voices.forEach((voice, i) => { const o = document.createElement("option"); o.value = i; o.textContent = (i + 1) + " · " + String.fromCharCode(...voice.slice(145, 155)).replace(/[^\x20-\x7e]/g, "?"); $("tt-voice").append(o); });
      selected = { patch: true };
    } else if (bytes[3] === 84) selected = { timbre: true, data: globalThis.FM1Web.readTimbreFile(bytes) };
    else selected = { data: globalThis.FM1Web.readProjectFile(bytes) };
    $("tt-voice").hidden = !selected.patch;
    enable();
    say(selected.patch && state[8 + state[0] * 20] !== 0 ? "音色校验通过，请先选择 DX7 轨道再导入。" : "文件校验通过，点击“导入到仿真”应用。");
  });
  $("tt-file-apply").onclick = () => action(async () => {
    if (!selected) return;
    if (!confirm(globalThis.FM1I18n.t("将替换仿真工作区" + (selected.patch ? "当前 DX7 音色" : selected.timbre ? "当前轨道音色" : "项目") + "，继续吗？"))) return;
    const data = selected.patch ? voices[+$("tt-voice").value] : selected.data;
    await request("import", { patch: !!selected.patch, timbre: !!selected.timbre, data });
    say("已导入仿真工作区。");
  });
  $("tt-project-export").onclick = () => action(async () => { save(globalThis.FM1Web.projectFile(await request("export")), "FM1-Open.fm1"); say("已导出仿真工作区项目。"); });
  $("tt-timbre-export").onclick = () => action(async () => { save(globalThis.FM1Web.timbreFile(await request("export", { timbre: true })), "FM1-timbre.fm1t"); say("已导出当前轨道的音源类型与全部音色参数。"); });

  function enable() {
    for (const e of root.querySelectorAll("[data-sim]")) e.disabled = !ready;
    $("tt-file-apply").disabled = !ready || !selected || (selected.patch && (!state || state[8 + state[0] * 20] !== 0));
    $("tt-factory-load").disabled = !ready || $("tt-factory").value === "";
  }
  function setReady(on, factories) {
    ready = on;
    if (factories) {
      factoryNames = factories;
      const f = $("tt-factory");
      f.replaceChildren();
      const choose = document.createElement("option");
      choose.value = "";
      choose.disabled = true;
      T(choose, "选择内置预设…");
      f.append(choose);
      factories.forEach((name, i) => { const o = document.createElement("option"); o.value = i; o.textContent = String(i + 1).padStart(2, "0") + " · " + name; f.append(o); });
      f.value = "";
    }
    entries = null;
    enable();
    if (on && $("tt-samples-box").open) action(bank);
  }

  // ---- a frame
  function receive(m) {
    const before = state;
    state = m.state;
    if (m.workspace) {
      $("tt-project-name").textContent = m.workspace.name || "UNTITLED";
      T($("tt-project-note"), m.workspace.dirty ? "工作区有修改" : "工作区未修改");
      if (m.workspace.factory && $("tt-factory").value !== String(m.workspace.slot) && factoryNames[m.workspace.slot]) $("tt-factory").value = String(m.workspace.slot);
    }
    if (!before || before[0] !== state[0] || before[8 + state[0] * 20] !== state[8 + state[0] * 20]) {
      $("tt-track").value = state[0];
      $("tt-source").value = state[8 + state[0] * 20];
    }
    for (let t = 0; t < 8; t++) {
      const at = 8 + t * 20, { lane, eng, meter, dots } = lanes[t];
      if (!before || before[0] !== state[0]) lane.classList.toggle("sel", state[0] === t);
      if (!before || before[at] !== state[at]) eng.textContent = SOURCES[state[at]] || "?";
      if (!before || before[at + 4] !== state[at + 4]) lane.classList.toggle("muted", !!state[at + 4]);
      if (!before || before[at + 5] !== state[at + 5]) lane.classList.toggle("solo", !!state[at + 5]);
      meter.style.width = (state[at + 3] / 127 * 100) + "%";
      for (let byte = 0; byte < 8; byte++) {
        const mask = at + 12 + byte, changed = before ? before[mask] ^ state[mask] : 255;
        if (changed) for (let bit = 0; bit < 8; bit++) if (changed & (1 << bit)) dots[byte * 8 + bit].classList.toggle("on", !!(state[mask] & (1 << bit)));
      }
      if (!before || before[209 + t] !== state[209 + t]) for (let i = 0; i < 64; i++) dots[i].classList.toggle("outside", i >= state[209 + t]);
      if (!before || before[at + 6] !== state[at + 6] || before[at + 7] !== state[at + 7]) {
        if (before && before[at + 6] && before[at + 7] < 64) dots[before[at + 7]].classList.remove("play");
        if (state[at + 6] && state[at + 7] < 64) dots[state[at + 7]].classList.add("play");
      }
    }
    if (!before || before[1] !== state[1])
      for (const b of root.querySelectorAll("[data-page]")) b.setAttribute("aria-pressed", String(+b.dataset.page === state[1] || (+b.dataset.page === 15 && state[1] === 5)));
  }
  return { receive, setReady };
}
