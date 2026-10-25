// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin's static site (web/plugin/build.mjs calls it), for Cloudflare Pages or any static host, after weavejam's
// FM-1 plugins (web/plugin/site.mjs):
//   PLUGIN_CHANNEL=production|preview node web/plugin/site.mjs WASM OUT FM1_VERSION
//   OUT/tutti-plugin.json   the manifest (protocol-v0 1), CORS * (_headers)
//   OUT/_headers            Cloudflare Pages: the manifest's CORS and no-cache, frame-ancestors (the channel's embedders),
//                           the plugin page's CSP, wasm's type
//   OUT/plugin/             the entry: the page (index.html, its modules and styles), the wasm, sdk/I18n.js and
//                           sdk/WebUpdate.js as they are
//   OUT/credits.html, OUT/licenses/   who made what, the licences (LICENSE.md with the GPL's text, THIRD_PARTY.md), the
//                           source, the non-affiliation notice
//   OUT/index.html          a landing page
// The build id is a hash of everything served but the manifest and plugin/build-info.js (which carry it), and the channel.
// PLUGIN_CHANNEL (required): which pages may embed it (protocol.js CHANNELS), into both plugin/build-info.js (EMBEDDERS,
// the handshake's check) and _headers (frame-ancestors): production exactly https://tuttidaw.com and
// https://www.tuttidaw.com; preview those and http://localhost:<any port>.
// The source link is the commit built (git HEAD): no commit, or a tree with changes not in it, fails the build
// (PLUGIN_ALLOW_DIRTY=1 lets a preview build through, marked as such; never a production one).
// Env: PLUGIN_SOURCE (the source repository, default https://github.com/weavejam/fm1_open).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { OUTPUTS, SAMPLE_RATES, TRACKS } from "./renderer.js";
import { STATE_VERSION, STATE_READS } from "./state.js";
import { PROTOCOL, CHANNELS } from "./protocol.js";

export const PLUGIN_VERSION = "0.1.0";                 // semver of the plugin (+ FM1 Open's version as build metadata)
export const UPSTREAM = "https://github.com/m-vave/fm1_open";
export const NOTICE = "Unofficial plugin build of M-VAVE's open-source FM1 Open firmware by weavejam. Not affiliated with or endorsed by M-VAVE.";
const [wasmPath, out, fwVersion = "dev"] = process.argv.slice(2);
if (!wasmPath || !out) { console.error("usage: node web/plugin/site.mjs WASM OUT FM1_VERSION"); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (...p) => path.join(ROOT, ...p);
const fail = (m) => { console.error(`site: ${m}`); process.exit(1); };
const channel = process.env.PLUGIN_CHANNEL;
if (!Object.hasOwn(CHANNELS, channel)) fail(`PLUGIN_CHANNEL=${Object.keys(CHANNELS).join("|")} (not ${channel})`);
const EMBEDDERS = CHANNELS[channel];
const SOURCE = process.env.PLUGIN_SOURCE || "https://github.com/weavejam/fm1_open";
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
let commit = "", changes = "";
try { commit = git("rev-parse --verify HEAD"); changes = git("status --porcelain"); } catch (e) { fail(`no git commit to link the source to (${String(e.message).split("\n")[0]})`); }
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`no git commit to link the source to (${commit})`);
const dirty = changes !== "";
if (dirty && !(channel === "preview" && process.env.PLUGIN_ALLOW_DIRTY === "1"))
  fail(`the tree has changes not in ${commit.slice(0, 12)}: the source link would not be this build's source\n${changes}`);
const sourceAt = `${SOURCE}/tree/${commit}`;
const fw = fwVersion.replace(/[^0-9A-Za-z.-]/g, "-").toLowerCase();
const version = `${PLUGIN_VERSION}+fm1open.${fw}${dirty ? ".dirty" : ""}`;

fs.rmSync(out, { recursive: true, force: true });
const put = (rel, data) => {
  const f = path.join(out, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const copy = (from, rel) => put(rel, fs.readFileSync(from));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---- the plugin: the page, its modules, the wasm, the workbench's texts and file formats
copy(wasmPath, "plugin/fm1open.wasm");
for (const f of ["index.html", "device.css", "plugin.css", "tutti.js", "device.js", "panel.js", "samples.js", "protocol.js", "fm1-panel.js",
                 "engine.js", "renderer.js", "resample.js", "state.js", "render-worker.js", "worklet-tutti.js"])
  copy(src("web/plugin", f), `plugin/${f}`);
for (const f of ["I18n.js", "WebUpdate.js"]) copy(src("sdk", f), `plugin/${f}`);
const page = fs.readFileSync(src("web/plugin/index.html"), "utf8");

// ---- credits, licences, source
copy(src("LICENSE.md"), "licenses/LICENSE.md");
copy(src("THIRD_PARTY.md"), "licenses/THIRD_PARTY.md");
const STYLE = `<style>
body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; margin: 0; color: #111; background: #f4f4f5; }
main { max-width: 780px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 28px 0 8px; }
a { color: #0b57d0; } code { font-size: 13px; } .notice { padding: 10px 14px; background: #fff; border-left: 4px solid #111; }
td, th { text-align: left; vertical-align: top; padding: 4px 8px; border-bottom: 1px solid #ddd; } table { border-collapse: collapse; }
</style>`;
const src1 = (f) => `<a href="${esc(sourceAt)}/${f}">${esc(f)}</a>`;
put("credits.html", `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FM1 Open plugin · credits, licences, source</title>${STYLE}</head><body><main>
<h1>FM1 Open plugin for tuttidaw</h1>
<p>Version ${esc(version)} · <a href="plugin/">open the plugin</a></p>
<p class="notice"><strong>${esc(NOTICE)}</strong> It runs FM1 Open's own browser engine (the code of its workbench's
simulator) as a <a href="https://tuttidaw.com">tuttidaw</a> plugin. "M-VAVE" and "FM1" name the instrument and firmware
this build is compatible with; they are their owners' names, and no M-VAVE logo or endorsement is implied.</p>
<h2>Who made it</h2>
<ul>
<li><strong>FM1 Open</strong>, the firmware and browser workbench this plugin is built from (the eight tracks, the six
  engines, the sequencer, the effects, the panel and screen, the workbench's texts and file formats), by
  <strong>珠海笙科智能科技有限公司 (M-VAVE)</strong> and its contributors, published open source:
  <a href="${UPSTREAM}">${UPSTREAM.replace(/^https:\/\//, "")}</a>. Its third-party components and contributors (Open303,
  DaisySP, stmlib, MSFA / Dexed, emu2149, the SEA codec, Vikram Rojo's tuning work, ...) are listed in
  <a href="licenses/THIRD_PARTY.md">THIRD_PARTY.md</a>.</li>
<li>The tuttidaw plugin (the headless renderer, the fractional tempo, the stems, use B's MIDI, the state, the page around
  the device, the protocol): <strong>weavejam</strong>, in the fork
  <a href="${esc(SOURCE)}">${esc(SOURCE.replace(/^https:\/\//, ""))}</a> (<code>web/plugin/</code> and the
  <code>FM1_TUTTI</code> parts of <code>web/engine/</code>), after weavejam's plugins built from the Felucca, JIANT FM and
  SLOOP firmwares.</li>
</ul>
<h2>Licence</h2>
<p>FM1 Open's application and browser-engine sources are under the GNU General Public License version 3 only, with an
additional linking permission for M-VAVE's binary SDK (<a href="licenses/LICENSE.md">LICENSE.md</a>, which reproduces the
GPL's full text). This plugin's own code is GPL-3.0-only; the plugin as a whole is distributed under GPL-3.0-only. Parts
keep their own licences, each listed with its notice in <a href="licenses/THIRD_PARTY.md">THIRD_PARTY.md</a>:</p>
<table>
<tr><th>What</th><th>Licence</th></tr>
<tr><td>FM1 Open's application and web engine (${src1("app")}, ${src1("web/engine")}, ${src1("web/synth")} but the DX7
  files), the workbench's texts and file formats (${src1("sdk/I18n.js")}, ${src1("sdk/WebUpdate.js")}), the panel's look
  and code the plugin page ports (${src1("sdk/Update.html.in")}, ${src1("sdk/Simulator.js")}, ${src1("sdk/Samples.js")})</td>
  <td>GPL-3.0-only WITH the FM1 SDK linking exception</td></tr>
<tr><td>The synthesis engines adapted from Open303, DaisySP, stmlib, emu2149, SEA (${src1("third_party/synth")})</td><td>MIT</td></tr>
<tr><td>The DX7 model adapted from MSFA / Dexed (${src1("web/synth")} dx7*) and the original 128-voice DX7 bank
  (${src1("app/fm_factory.inc")})</td><td>Apache-2.0</td></tr>
<tr><td>The plugin (${src1("web/plugin")})</td><td>GPL-3.0-only</td></tr>
</table>
<p><strong>Not in this build:</strong> M-VAVE's proprietary binary SDK (<code>sdk/lib/*.a</code>), the device firmware,
its boot and recovery resources. The plugin is compiled from source only (WASI SDK 27's clang, the sources of FM1 Open's
browser simulator).</p>
<h2>Source</h2>
<p>The complete corresponding source of this build (the engine, the plugin, the site's build):
<a href="${esc(sourceAt)}">${esc(sourceAt)}</a>. Build it with <code>node web/plugin/build.mjs</code> (see
<code>web/plugin/README.md</code> there).${dirty ? `</p>
<p class="notice">A development build (preview): it was built from a tree with changes not in that commit.` : ""}</p>
</main></body></html>
`);
put("index.html", `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FM1 Open plugin for tuttidaw</title>${STYLE}</head><body><main>
<h1>FM1 Open plugin for tuttidaw</h1>
<p>FM1 Open, the open-source eight-track groovebox firmware, running in your browser as a
<a href="https://tuttidaw.com">tuttidaw</a> plugin (protocol <code>${PROTOCOL}</code>, manifest
<a href="tutti-plugin.json">tutti-plugin.json</a>): its panel on an FM1 Open of its own, its pattern rendered into tuttidaw
at tuttidaw's tempo, with a stem per track, or tuttidaw's MIDI played through its eight tracks.</p>
<p><a href="plugin/">Open it on its own</a> (your work stays in this browser) · <a href="credits.html">credits, licences, source</a></p>
<p class="notice">${esc(NOTICE)}</p>
</main></body></html>
`);
put("icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#10171c"/><g fill="#a9efd7">${
  Array.from({ length: 8 }, (_, t) => Array.from({ length: 4 }, (_, s) => ((t * 5 + s * 3) % 4 === 0 || s === t % 4) ? `<rect x="${12 + s * 11}" y="${10 + t * 5.6}" width="8" height="3.6" rx="1"/>` : "").join("")).join("")
}</g></svg>\n`);

// ---- the build id, the manifest, the headers
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
walk(out);
const h = crypto.createHash("sha256");
for (const f of files.map((f) => path.relative(out, f).split(path.sep).join("/")).sort()) {
  h.update(f + "\0");
  h.update(fs.readFileSync(path.join(out, f)));
}
h.update(`channel\0${channel}\0${EMBEDDERS.join(" ")}`);           // (the channel too: its embedders differ)
const build = h.digest("hex").slice(0, 16);
const manifest = {
  protocol: PROTOCOL,
  id: "com.weavejam.fm1open",
  name: "FM1 Open",
  vendor: "weavejam (FM1 Open firmware by M-VAVE, open source)",
  version,
  build,
  license: "GPL-3.0-only",
  source: sourceAt,
  upstream: UPSTREAM,                                  // (not a v0 field: receivers ignore it)
  notice: NOTICE,
  entry: "/plugin/",
  icon: "/icon.svg",
  state: { version: STATE_VERSION, reads: STATE_READS },
  capabilities: {
    ownSequencer: true,
    acceptsMidi: true,
    outputs: OUTPUTS,
    stemsSumToMix: false,
    tempoMap: "constant",
    sampleRates: SAMPLE_RATES,
    seek: false,                                       // every render plays from beat 0 (renderer.js)
    fm1Panel: true,                                    // a hardware FM-1 through tuttidaw (fm1-panel.js; protocol 12)
    midiChannels: Array.from({ length: TRACKS }, (_, t) => ({ channel: t, name: `T${t + 1}` })),
  },
};
put("tutti-plugin.json", JSON.stringify(manifest, null, 2) + "\n");
put("plugin/build-info.js", `// generated by web/plugin/site.mjs (PLUGIN_CHANNEL=${channel})
export const BUILD = ${JSON.stringify({ id: manifest.id, version, build, source: sourceAt, channel })};
export const EMBEDDERS = ${JSON.stringify(EMBEDDERS)};
`);
// the plugin page's policy: no inline script or handler at all, the scripts from this origin only
if (/<script(?![^>]*\bsrc=)/.test(page) || /\son[a-z]+\s*=\s*["']/i.test(page))
  throw new Error("site: plugin/index.html: no inline script or inline handler expected");
const ANCESTORS = EMBEDDERS.join(" ");
const PAGE_CSP = [`default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self'`,
                  `style-src 'self' 'unsafe-inline'`, `font-src 'self'`, `img-src 'self' data: blob:`, `media-src 'self' blob:`,
                  `frame-src 'none'`, `form-action 'none'`, `object-src 'none'`, `base-uri 'self'`,
                  `frame-ancestors ${ANCESTORS}`].join("; ");
// (Cloudflare Pages joins the values of every rule matching a path with commas: two policies, both enforced)
put("_headers", `# Cloudflare Pages (web/plugin/site.mjs, PLUGIN_CHANNEL=${channel})
/*
  Content-Security-Policy: frame-ancestors ${ANCESTORS}; object-src 'none'; base-uri 'self'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), midi=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
/tutti-plugin.json
  Access-Control-Allow-Origin: *
  Cache-Control: no-cache
  Content-Type: application/json; charset=utf-8
/*.wasm
  Content-Type: application/wasm
/plugin/*
  Content-Security-Policy: ${PAGE_CSP}
/plugin/fm1open.wasm
  Content-Type: application/wasm
`);
console.log(`plugin: ${out} (${channel}, ${files.length + 3} files, build ${build}, ${version})`);
