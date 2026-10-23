// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// Work off the page's thread (the live device and its UI stay live), after weavejam's FM-1 plugins: renders
// (renderer.js) in a module Worker, one at a time (the session allows no more); and the sample page's SEA5 encoding
// (Simulator.c sim_sample_encode, as the workbench's encoder worker in sdk/Samples.js does it) in a worker of its own.
//   in:  {type: render, wasmUrl, state, req}, {type: ack} (the last chunk went on: the next one may come),
//        {type: cancel}, {type: encode, wasmUrl, pcm (Int16Array, 32 kHz mono)}
//   out: {type: chunk, output, frameOffset, channels} (transferred), {type: progress, fraction}, {type: done, result},
//        {type: encoded, data} | {type: error, code, message}, {type: messageerror} (a message of the page's it could
//        not read)
import { render, RenderError } from "./renderer.js";

let module = null, cancel = false, wake = null, lastProgress = 0;

async function compile(url) {
  if (!module) {
    const res = await fetch(url);
    if (!res.ok) throw new RenderError("internal", `${url}: ${res.status}`);
    module = await WebAssembly.compile(await res.arrayBuffer());
  }
  return module;
}

// a message from the page that cannot be read: the render stops, the page ends the session (tutti.js stopWorker)
self.onmessageerror = () => {
  cancel = true;
  if (wake) wake();
  self.postMessage({ type: "messageerror" });
};

async function encode(m) {
  const { exports: c } = await WebAssembly.instantiate(await compile(m.wasmUrl), {});
  c._initialize();
  const input = c.sim_sample_alloc(m.pcm.length);
  if (!input) throw new RenderError("bad-request", "the audio is too long");
  new Int16Array(c.memory.buffer, input, m.pcm.length).set(m.pcm);
  const p = c.sim_sample_encode(), n = c.sim_sample_bytes();
  if (!p || !n) throw new RenderError("internal", "SEA5 encoding failed");
  const data = new Uint8Array(c.memory.buffer, p, n).slice();
  self.postMessage({ type: "encoded", data }, [data.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "ack" || m.type === "cancel") {
    if (m.type === "cancel") cancel = true;
    if (wake) wake();
    return;
  }
  if (m.type === "encode") {
    try { await encode(m); } catch (err) { self.postMessage({ type: "error", code: err && err.code || "internal", message: String(err && err.message || err) }); }
    return;
  }
  if (m.type !== "render") return;
  cancel = false;
  try {
    const mod = await compile(m.wasmUrl);
    const result = await render(mod, m.state, m.req, {
      cancelled: () => cancel,
      progress: (fraction) => {
        const t = Date.now();
        if (t - lastProgress < 50 && fraction < 1) return;
        lastProgress = t;
        self.postMessage({ type: "progress", fraction });
      },
      chunk: (output, frameOffset, channels) => new Promise((res, rej) => {
        wake = () => {
          wake = null;
          if (cancel) rej(new RenderError("cancelled", "cancelled"));
          else res();
        };
        self.postMessage({ type: "chunk", output, frameOffset, channels }, channels.map((c) => c.buffer));
      }),
    });
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", code: err && err.code || "internal", message: String(err && err.message || err) });
  }
};
