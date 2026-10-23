// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// FM1 Open for tuttidaw (web/plugin/README.md): the engine built with FM1_TUTTI (web/plugin/fm1_plugin.c) by WASI SDK
// 27's clang, from source only (the sources and options of tools/Build-Web.ps1's simulator; never sdk/lib), and the
// static site that serves it, per deployment channel:
//   node web/plugin/build.mjs                               ->  build/plugin-wasm/fm1open.wasm, build/plugin-site-preview/
//   PLUGIN_CHANNEL=production node web/plugin/build.mjs     ->  build/plugin-site/ (the one to deploy)
//   PLUGIN_CHANNEL="production preview" ...                 ->  both (one wasm)
// The compiler: FM1_WASI_SDK (an extracted WASI SDK 27), else build/tools/wasi-sdk-27.0-<arch>-<os> (where
// tools/Build-Web.ps1 keeps the one it downloads). The site links its source to the commit built: the tree must be
// clean (PLUGIN_ALLOW_DIRTY=1: a preview anyway, marked; see site.mjs). PLUGIN_OPT replaces -O2.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (...p) => path.join(ROOT, ...p);
const fail = (m) => { console.error(`plugin: ${m}`); process.exit(1); };

const host = process.platform === "win32" ? "x86_64-windows" : `${process.arch === "arm64" ? "arm64" : "x86_64"}-${process.platform === "darwin" ? "macos" : "linux"}`;
const sdk = path.resolve(process.env.FM1_WASI_SDK || rel("build/tools", `wasi-sdk-27.0-${host}`));
const clang = path.join(sdk, "bin", process.platform === "win32" ? "clang.exe" : "clang");
if (!fs.existsSync(clang) || !fs.existsSync(path.join(sdk, "share/wasi-sysroot")))
  fail(`no WASI SDK 27 at ${sdk}: set FM1_WASI_SDK (tools/Build-Web.ps1 downloads one into build/tools)`);
const version = spawnSync(clang, ["--version"], { encoding: "utf8" }).stdout || "";
if (!/clang version 20\.1\.8\b/.test(version)) fail(`${clang} is not WASI SDK 27's clang (20.1.8): ${version.split("\n")[0]}`);

// the simulator's sources, as tools/Build-Web.ps1 lists them (app, web, third_party/synth; not app/board, not
// web/plugin), ordinal order, then the plugin's
const sources = [];
const walk = (d) => {
  for (const e of fs.readdirSync(rel(d), { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".c") && !p.startsWith("app/board/") && !p.startsWith("web/plugin/")) sources.push(p);
  }
};
for (const d of ["app", "web", "third_party/synth"]) walk(d);
sources.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
sources.push("web/plugin/fm1_plugin.c");

const appVersion = /^#define FM1_RELEASE_VERSION "(V\d+)"/m.exec(fs.readFileSync(rel("app/version.h"), "utf8"));
if (!appVersion) fail("app/version.h: no FM1_RELEASE_VERSION");
fs.mkdirSync(rel("build/plugin-wasm"), { recursive: true });
const wasm = rel("build/plugin-wasm/fm1open.wasm");
const args = [`--sysroot=${path.join(sdk, "share/wasi-sysroot")}`, "-std=c11", ...(process.env.PLUGIN_OPT || "-O2").split(/\s+/),
              "-fwrapv", "-fno-fast-math", "-ffp-contract=off", "-DFM1_HOST_TEST", "-DFM1_OPEN_WEB", "-DFM1_TUTTI",
              "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-Wno-array-parameter", "-mexec-model=reactor",
              ...["web/engine", "web/synth", "third_party/synth", "sdk/include", "app/synth", "app"].map((d) => `-I${rel(d)}`),
              ...sources.map((s) => rel(s)),
              "-Wl,--strip-all", "-Wl,-z,stack-size=131072", "-Wl,--initial-memory=8388608", "-Wl,--max-memory=33554432",
              "-o", wasm];
console.log(`plugin: ${path.relative(ROOT, clang)} -> build/plugin-wasm/fm1open.wasm (${sources.length} sources)`);
const cc = spawnSync(clang, args, { cwd: ROOT, stdio: "inherit" });
if (cc.status !== 0) fail("the compile failed");
// the engine runs with an empty import object (sdk/Simulator.js): no WASI imports
const imports = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync(wasm)));
if (imports.length) fail(`fm1open.wasm imports ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);

for (const channel of (process.env.PLUGIN_CHANNEL || "preview").split(/\s+/).filter(Boolean)) {
  const out = { production: "build/plugin-site", preview: "build/plugin-site-preview" }[channel];
  if (!out) fail(`PLUGIN_CHANNEL: production and/or preview (not ${channel})`);
  const r = spawnSync(process.execPath, [rel("web/plugin/site.mjs"), wasm, rel(out), appVersion[1]],
                      { cwd: ROOT, stdio: "inherit", env: { ...process.env, PLUGIN_CHANNEL: channel } });
  if (r.status !== 0) process.exit(r.status || 1);
}
