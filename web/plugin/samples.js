// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The sample bank's format and a WAV's checks, for the plugin page's sample slots: the DOM-free part of the workbench's
// sdk/Samples.js (FM1 Open, GPL-3.0-only WITH GPL-3.0-linking-exception; here under GPL-3.0-only), as it is: eight
// slots of SEA5-coded 32 kHz mono audio in one bank ("FM1S" header, 512 bytes), at most 446464 bytes.
// FM1Web (sdk/WebUpdate.js, a classic script before this page's modules) gives the CRC-32.
export const SLOTS = 8, DISK_SLOTS = 16, CAPACITY = 446464, REGION = 466944, HEADER = 512, RATE = 32000;
export const CHUNK_FRAMES = 320, CHUNK_BYTES = 228, MAX_FILE = 32 * 1024 * 1024;
export const MAX_FRAMES = Math.floor((REGION - HEADER) / CHUNK_BYTES) * CHUNK_FRAMES;
const check = (ok, message) => { if (!ok) throw Error(message); };
const crcZero = new Uint8Array(8);
export const crc = (data) => {
  let value = globalThis.FM1Web.crc32(data.subarray(0, 12));
  value = globalThis.FM1Web.crc32(crcZero.subarray(0, Math.max(0, Math.min(8, data.length - 12))), value);
  return globalThis.FM1Web.crc32(data.subarray(20), value);
};
export function read(data) {
  check(data instanceof Uint8Array && data.length >= HEADER && data.length <= REGION, "采样库长度无效");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  check(v.getUint32(0, true) === 0x53314d46 && v.getUint32(4, true) === 1 && v.getUint32(8, true) === data.length &&
    v.getUint32(16, true) === 0 && v.getUint32(20, true) === RATE && v.getUint32(24, true) === 0 && v.getUint32(28, true) === 0, "采样库格式无效");
  check(v.getUint32(12, true) === crc(data), "采样库校验失败");
  check(data.slice(480, 512).every((b) => b === 0), "采样库保留字段无效");
  let next = HEADER;
  const entries = [];
  for (let i = 0; i < DISK_SLOTS; i++) {
    const at = 32 + i * 28, offset = v.getUint32(at, true), frames = v.getUint32(at + 4, true), bytes = v.getUint32(at + 8, true);
    const name = data.slice(at + 12, at + 28);
    check(offset === next && frames <= MAX_FRAMES && bytes === Math.ceil(frames / CHUNK_FRAMES) * CHUNK_BYTES && bytes <= data.length - next && name[15] === 0 &&
      name.every((b) => b === 0 || (b >= 32 && b <= 126)), "采样槽 " + (i + 1) + " 无效");
    for (let p = offset; p < offset + bytes; p += CHUNK_BYTES) check(v.getUint32(p, true) === 0x5a144501, "SEA5 数据块无效");
    entries.push({ name: String.fromCharCode(...name).replace(/\0.*$/s, ""), frames, data: data.slice(offset, offset + bytes) });
    next += bytes;
  }
  check(next === data.length, "采样库包含多余数据");
  check(entries.slice(SLOTS).every((s) => !s.frames && !s.name), "采样库格式无效");
  return entries.slice(0, SLOTS);
}
export function pack(entries, capacity = CAPACITY) {
  check(entries.length === SLOTS, "采样库必须包含 8 个槽位");
  const size = HEADER + entries.reduce((n, s) => n + s.data.length, 0);
  check(size <= capacity, "采样空间不足，请缩短音频或清空其他槽位");
  const data = new Uint8Array(size), v = new DataView(data.buffer);
  v.setUint32(0, 0x53314d46, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, size, true);
  v.setUint32(20, RATE, true);
  let offset = HEADER;
  entries.forEach((s, i) => {
    const at = 32 + i * 28;
    v.setUint32(at, offset, true);
    v.setUint32(at + 4, s.frames, true);
    v.setUint32(at + 8, s.data.length, true);
    const name = s.name.replace(/[^\x20-\x7e]/g, "_").slice(0, 15);
    data.set(Array.from(name, (c) => c.charCodeAt(0)), at + 12);
    data.set(s.data, offset);
    offset += s.data.length;
  });
  for (let i = SLOTS; i < DISK_SLOTS; i++) v.setUint32(32 + i * 28, offset, true);
  v.setUint32(12, crc(data), true);
  read(data);
  return data;
}
export function wavInfo(data) {
  check(data instanceof ArrayBuffer && data.byteLength >= 44 && data.byteLength <= MAX_FILE, "请选择不超过 32 MiB 的标准 WAV 文件");
  const v = new DataView(data), tag = (at) => String.fromCharCode(...new Uint8Array(data, at, 4));
  check(tag(0) === "RIFF" && tag(8) === "WAVE" && v.getUint32(4, true) + 8 === data.byteLength, "WAV 文件不完整或格式无效");
  let format, bytes;
  for (let at = 12; at < data.byteLength;) {
    check(at + 8 <= data.byteLength, "WAV 文件不完整或格式无效");
    const size = v.getUint32(at + 4, true), start = at + 8, end = start + size;
    check(end <= data.byteLength, "WAV 文件不完整或格式无效");
    if (tag(at) === "fmt ") {
      check(!format && size >= 16, "WAV 文件不完整或格式无效");
      let kind = v.getUint16(start, true);
      const channels = v.getUint16(start + 2, true), rate = v.getUint32(start + 4, true), align = v.getUint16(start + 12, true), bits = v.getUint16(start + 14, true);
      if (kind === 0xfffe) {
        check(size >= 40 && v.getUint16(start + 16, true) >= 22 && v.getUint16(start + 18, true) === bits &&
          [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113].every((n, i) => v.getUint8(start + 28 + i) === n), "不支持此 WAV 编码，请导出 PCM 或 32 位浮点 WAV");
        kind = v.getUint32(start + 24, true);
      }
      check((kind === 1 && [8, 16, 24, 32].includes(bits)) || (kind === 3 && bits === 32), "不支持此 WAV 编码，请导出 PCM 或 32 位浮点 WAV");
      check((channels === 1 || channels === 2) && rate >= 8000 && rate <= 192000, "WAV 仅支持单声道或立体声，采样率 8–192 kHz");
      check(align === channels * bits / 8 && v.getUint32(start + 8, true) === rate * align, "WAV 文件不完整或格式无效");
      format = { channels, rate, align, bits };
    } else if (tag(at) === "data") { check(bytes === undefined, "WAV 文件不完整或格式无效"); bytes = size; }
    at = end + (size & 1);
    check(at <= data.byteLength, "WAV 文件不完整或格式无效");
  }
  check(format && bytes > 0 && bytes % format.align === 0, "WAV 文件不完整或格式无效");
  const duration = bytes / format.align / format.rate;
  check(duration <= 120, "WAV 原文件最长 120 秒，请先裁剪后再导入");
  return { ...format, duration };
}
export function availableFrames(entries, slot) {
  check(Number.isInteger(slot) && slot >= 0 && slot < SLOTS, "请选择有效采样槽");
  const used = HEADER + entries.reduce((sum, s, i) => sum + (i === slot ? 0 : s.data.length), 0);
  return Math.max(0, Math.floor((CAPACITY - used) / CHUNK_BYTES) * CHUNK_FRAMES);
}
