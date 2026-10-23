# FM1 Open for tuttidaw (`web/plugin/`)

weavejam's plugin build of [FM1 Open](https://github.com/m-vave/fm1_open) for [tuttidaw](https://tuttidaw.com) (protocol
`tutti-plugin/0`, an "L0 offline plugin"): FM1 Open's own browser engine (the code of its workbench's simulator) as a
device in the page with the workbench's panel around it, and a headless renderer that renders the working project's
pattern, or MIDI from tuttidaw through the eight tracks, offline into a mix and seven stems (T1 .. T5, T6 + T7, T8), at tuttidaw's tempo.
**Unofficial plugin build of M-VAVE's open-source FM1 Open firmware by weavejam. Not affiliated with or endorsed by
M-VAVE.** "M-VAVE" and "FM1" name what it is compatible with; no M-VAVE logo is used. The plugin's own code is
GPL-3.0-only; FM1 Open's sources keep their licences (LICENSE.md: GPL-3.0-only with the FM1 SDK linking exception;
THIRD_PARTY.md: `third_party/synth` MIT, the DX7 model and `app/fm_factory.inc` Apache-2.0). The design (protocol code,
renderer, Worker, resampler, engine, site, CI, tests) is ported from weavejam's plugins of the FM-1 firmwares Felucca,
JIANT FM and SLOOP ([weavejam/Felucca](https://github.com/weavejam/Felucca), [weavejam/JIANT](https://github.com/weavejam/JIANT),
[weavejam/sloop-fm1](https://github.com/weavejam/sloop-fm1), `web/plugin/`), with every fix their reviews brought.

**From source only.** The plugin is compiled from the sources `tools/Build-Web.ps1` compiles for the workbench's
simulator (`web/engine`, `web/synth`, `third_party/synth`, `app/` without `app/board`, headers from `sdk/include`) plus
`fm1_plugin.c`. Nothing of M-VAVE's binary SDK (`sdk/lib/*.a`) is used or shipped.

## Build, run, test

```
node web/plugin/build.mjs                         # -> build/plugin-wasm/fm1open.wasm, build/plugin-site-preview/
PLUGIN_CHANNEL=production node web/plugin/build.mjs        # -> build/plugin-site/ (the one to deploy)
PLUGIN_CHANNEL="production preview" node web/plugin/build.mjs   # both, one wasm
node web/plugin/plugin_test.mjs [build/plugin-wasm/fm1open.wasm]   # FAST=1: without the slow checks
node web/plugin/dev/serve.mjs   # the preview site on http://127.0.0.1:8791/, a stand-in host on http://localhost:8792/
```

The compiler is **WASI SDK 27** (clang 20.1.8; `build.mjs` checks the version): `FM1_WASI_SDK` (an extracted SDK), else
`build/tools/wasi-sdk-27.0-<arch>-<os>`, where `tools/Build-Web.ps1` keeps the one it downloads (Windows: SHA-256
`4a576c13...adf6`; the workflow pins the Linux tarball by its SHA-256). The options are `Build-Web.ps1`'s (`-std=c11 -O2
-fwrapv -fno-fast-math -ffp-contract=off -DFM1_HOST_TEST -DFM1_OPEN_WEB -Wall -Wextra -Werror -mexec-model=reactor`,
128 KiB stack) plus `-DFM1_TUTTI`; the memory starts at 8 MiB (the render buffers), at most 32 MiB; the wasm imports
nothing (it runs with an empty import object, as the workbench's). Node 24.

**Channels.** `PLUGIN_CHANNEL` (`production`, `preview`, or both separated by a space; default `preview`) decides which
pages may embed the build, and `site.mjs` writes that one list into both the page's `plugin/build-info.js`
(`EMBEDDERS`, the handshake's check) and `_headers`' `frame-ancestors`:

| Channel | Embedders | Out |
| --- | --- | --- |
| `production` | exactly `https://tuttidaw.com`, `https://www.tuttidaw.com` | `build/plugin-site/` |
| `preview` | those and `http://localhost:<any port>` (tuttidaw's dev server, `dev/`) | `build/plugin-site-preview/` |

Deployed (Cloudflare Pages): production at `https://fm1open.plugins.tooljams.com`, preview at
`https://fm1open-preview.plugins.tooljams.com` (the manifest: `/tutti-plugin.json` on each).
`.github/workflows/plugin-site.yml` builds both from one wasm, runs the tests, and keeps the production site as an
artifact on a push to main (the only event a deployment may come from), the preview site on a pull request.

**Source links.** The manifest's `source`, the credits page and the page's footer link the exact commit built
(`<repo>/tree/<sha>`). With no commit, or a tree with changes not in it, the build fails; `PLUGIN_ALLOW_DIRTY=1` lets a
preview through, its version marked `.dirty` (never a production build).

**The page's CSP** (`/plugin/*`): `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self'
blob:; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors ...`. The page has no
inline script or handler (`site.mjs` fails the build otherwise).

| File | What |
| --- | --- |
| `fm1_plugin.c` | with the simulator's sources, built with `FM1_TUTTI`: the host's tempo, the clock kept internal, the headless render (use A, use B), each track's share for its stem, a stem's own buses, the preview's place, the state's signature |
| `renderer.js` | a render: the time map's geometry, the request checked, a fresh instance per render, mix and stems, 48 kHz |
| `resample.js` | 44.1 kHz to 48 kHz (Felucca's, as is) |
| `state.js` | the state blob (the working project, the flash's sectors), how an instance boots with it |
| `protocol.js` | the session: handshake, messages, state machine, credited chunks (Felucca's, `commit`'s `lengthBeats` added) |
| `engine.js` | state revisions, renders of a revision, the live FM1 |
| `worklet-tutti.js` | the page's FM1 Open in an AudioWorklet: the workbench's simulator operations, the host's tempo and transport |
| `device.js`, `device.css` | the FM1 panel: the workbench's (`sdk/Simulator.js`, `sdk/Update.html.in`), ported to the worklet |
| `panel.js`, `samples.js` | the companion panel: project, factory projects, the 8 track lanes, edit pages, sample slots, files |
| `tutti.js`, `index.html`, `plugin.css`, `render-worker.js` | the page: the layout, the protocol, renders (and sample coding) in a Worker |
| `site.mjs`, `build.mjs` | the static site, the manifest; the build |
| `dev/` | a stand-in host and a server for development |
| `plugin_test.mjs` | the tests (Node) |

## The page

The FM1 panel as the workbench draws it (`sdk/Update.html.in`'s device: the 240 x 240 screen with its click-to-edit
targets, the encoders, the twelve buttons with their LEDs, the 27 keys, Shift-click / right-click to latch a button,
the computer keyboard Z S X D C ... as in the workbench), driven by the page's own FM1 Open (`worklet-tutti.js`, the
workbench's simulator operations), and beside it the workbench's parts that matter in a DAW (`panel.js`): the project
(its name, edited or not), the 16 factory projects, the current track and its engine, the **8 track lanes** (engine,
level meter, mute / solo, the 64 steps with each track's loop length and the playhead; a click selects the track), the
edit pages (sound, steps, mix, FX, envelope, LFO, arpeggiator, ...), the **8 sample slots** (a WAV decoded at 32 kHz,
mixed to mono, SEA5-coded as the workbench does it, into a slot; a slot emptied; the demo bank back), and files (a
project `.fm1`, a timbre `.fm1t`, a DX7 `.syx` in; the project or a timbre out, when the page is opened by itself: a
sandboxed frame has no downloads). The texts are the workbench's, through its `sdk/I18n.js` (English; `?lang=zh-CN`
for 简体中文). The bar: Play / Stop, TAP, Panic, **Render to tuttidaw** (with "stems T1-T8"), the monitor volume
(MASTER), the status; the footer: the notice, the credits, the source.

**Any frame size** (`tutti.js layout`). The page fills the frame and never scrolls as a whole; the panel is drawn in
container units of its box (`device.css`), which the layout sizes, so it is crisp at any size and every hit area is where
its control is drawn.

- **Wide** (>= 900 px and aspect >= 1.3): the device as large as fits on the left, the companion panel on the right
  (340 .. 560 px).
- **Tall** (height >= 1.15 x width, a phone's sheet): the device across the top, the panel under it.
- **Otherwise** (a small or square window): the device alone, scaled to fit, the bar over it.

The panel's sections scroll on their own when the frame is short (no scrollbar drawn). `resize` is sent once connected
with 1280 x 800, the wide layout's size, as a hint; the page fits whatever size the host gives it. Checked in Chromium
at 1280 x 820, 1600 x 900 (wide), 900 x 700, 480 x 360 (device alone), 390 x 780 (tall): no page scrollbar, every bar,
panel and device control in view and hit at its centre (the repository keeps no images, so neither do these
checks' screenshots).

- In tuttidaw's frame: the handshake (accepted from the build's channel's embedders, from the parent window only), then
  `init`. Edit mode: FM1 Open starts with the state (on its own where the browser lets the frame play sound, else with
  "Start audio"; any click or key starts it). It saves nothing in this browser; tuttidaw's transport drives its preview
  (listen-only: it starts at `atEpochMs` less the output latency, placed at once where the host is, a drift of over
  20 ms re-places it). Renders run in a Worker, so FM1 Open and its panel stay live. `mode: "render"` is headless: no
  FM1 in the page, no audio, only renders.
- **Render to tuttidaw** sends `commit` with `fromBeat` 0, `toBeat` and `lengthBeats` (protocol 4b) = one pass of the
  pattern: until every track's loop meets again (the least common multiple of the tracks' lengths of 16, 32, 48 or 64
  steps: 4 .. 48 beats), and the outputs (the mix, or the mix and the seven stems).
- **Tempo while hosted.** The host's tempo is a runtime value: the project's tempo (in the state; the screen's BPM, TAP)
  stays as it was, so tuttidaw's tempo never changes the state or starts a new revision. Opened by itself the page sets
  no tempo: FM1 Open plays its project's.
- **The clock while hosted.** FM1 Open can follow an external MIDI clock (SEQ > SYNC / LOOP, a device setting). Hosted
  (and in every render) the clock is kept internal, as a runtime override (`fm1_tutti_clock_internal`, the
  `groove_clock_set` hook): the host's tempo drives it; the saved setting stays the user's (the state keeps it).
- **Sessions.** As Felucca's: a request keeps the session it came in with; what it sends after that session has ended
  goes nowhere; a render still running in the Worker when the next session renders is stopped with its Worker; the
  port's `messageerror` (or one between the page and the Worker) ends the session.
- Opened by itself (or not connected within 4 s): FM1 Open on its own, the state kept in this browser
  (`localStorage`), a note; a `connect` after that is refused (reload the frame to connect).
- `/credits.html`: who made what, the licences (LICENSE.md with the GPL's full text, THIRD_PARTY.md, both as they are),
  the source of the build, the non-affiliation notice.

## What changes in FM1 Open (`FM1_TUTTI`)

Only builds that define `FM1_TUTTI` (this plugin's) change. The hooks are in `web/engine/` only (`internal.h`,
`sequencer.c`, `sound.c`), which the device firmware does not compile (it links M-VAVE's engine instead): the device
build's sources are untouched. The workbench's simulator preprocesses to the same code as before: `clang -E -P` of all
32 simulator sources with `Build-Web.ps1`'s options is identical to main's, and `tools/Build-Web.ps1 -LocalPreview`
builds a byte-identical `build/web/simulator.wasm` (SHA-256 `a62ea3c1...9b80` on both). `tools/Build-Web.ps1` skips
`web/plugin/` (it compiles every `.c` under `web/`), so the plugin's file never enters the workbench's build or its
source hash.

- **Fractional tempo.** The sequencer's clock counts units of a frame at 1/4 BPM (`sequencer.c`: a sixteenth is
  44100 x 60 units, a block of 128 frames adds `tempo x 4 x 128`), so an integer BPM has no drift; hosted, the host's
  tempo is a BPM in Q32 (`fm1_tutti_bpm_q32`) and a block adds `bpm_q32 x 4 x 128 >> 32` with the fraction carried to
  the next block: after any number of blocks the clock is within one unit (1 / (4 x BPM) of a frame) of the exact
  position. The arpeggiator's clock (`groove_arp_render`, 24 pulses a beat) carries its fraction the same way, and the
  delay's sync (`delay_ticks`, `effects_poll`) takes its time from the exact tempo. `plugin_test.mjs`: 64 bars at
  123.45 BPM, every bar line on the clock within 0.01 frames of `bar x 4 x 60 / bpm x 44100`.
- **Per-track capture.** With `fm1_tutti_capture` on, `render_stereo` (and the mono path) keeps each track's share of
  the sums as it adds it (the same `fm1_mix128` / `fm1_send128` products, not summed with the others): its dry left and
  right after its gain, pan, mute / solo and LFO, and its reverb and delay sends. The mix is computed as before: bit for
  bit the same with or without capture (tested).
- **No click in a render** (`fm1_tutti_no_click`: a project with the metronome always on renders without it).
- **The preview's place** (`fm1_tutti_locate`): the running transport put at a sixteenth and a phase at once (a step
  just begun, within a block, sounds with the next block: a preview started on beat 0 or a loop's start has its
  downbeat), every
  track at its own loop position.

## Stems and the mix

- `mix` is FM1 Open's output as the device makes it: the eight tracks, the reverb and delay buses
  (`web/engine/effects.c`), the bus output, the block-level master limiter (`web/synth/mixer.c
  fm1_master_process128`), the output level at MASTER's top (`app/audio_output.c`; the page's volume is the live FM1's
  only). The metronome's click is never in a render.
- **Seven stems, not eight.** Protocol v0 allows 8 outputs at most, the mix among them (section 1 and 6), and FM1 Open
  has eight tracks: `t1` .. `t5` and `t8` are one track each, `t67` is T6 and T7 together (their shares summed before
  the buses). T6 and T7 are the ones a new FM1 mutes; T8 is the 808 by default. (A protocol question in the pull
  request: more outputs in a later version.)
- `t1` .. `t5`, `t67`, `t8` are each track's share of the mix plus **its own share of the buses**: in an instance of its own (booted
  with the same state at the same tempo, so its reverb and delay are set as the mix's), the track's sends go through
  that instance's reverb and delay (`fm1_fx_render`), added to the track's dry share, then the bus output, **the mix's
  limiter gain** of that block (so a stem is as loud as its track is in the limited mix: Felucca's `tutti_stem_render`
  design), the output level and the 24-bit limit, a block late as the mix comes.
- `stemsSumToMix: false`: the buses are not linear (their 16-bit saturation, their gate that stops them after a quiet
  time, the mix's sums saturate where a stem's alone do not). With one track playing its stem is the mix bit for bit;
  with the test groove (six tracks, reverb and delay sends) the stems add up to the mix within about -67 dB of the mix.
  A muted or empty track gives a silent stem (a new FM1 mutes T6 and T7).
- Cost (Node 24, factory project 02): 60 s of the mix alone renders in 1.2 s, with the seven stems in 1.8 s; at 48 kHz
  with the stems 15 s, almost all of it the resampler (Felucca's, eight outputs).

## Timing

- **Blocks.** FM1 Open's engine renders blocks of 128 frames only (the DX7 voices are made for 128-frame blocks, the
  mixer and the buses work on 128 frames, `fm1_engine_render` refuses another size), and takes its events between
  blocks; a block cannot be split at an event's frame without changing the engine. So events are **quantised to
  128-frame blocks (2.9 ms at 44.1 kHz)**, each to the block start nearest to its exact time (within 64 frames, 1.45 ms):
  a render's sequencer clock starts half a block ahead (`fm1_tutti_start_phase`), so a step sounds at the nearest block
  start rather than the next one (on the FM1 itself: 0 .. 127 frames late); step 0 at frame 0 (`plugin_test.mjs`: bar
  64's kick at 123.45 BPM 56.6 frames after its bar line, bar 0's at frame 0); a MIDI event of use B likewise (tested:
  a note at beat 1, frame 22050, sounds at frame 22032).
- **Latency.** `sim_render` gives the block before the one it renders: the renderer drops those 128 frames
  (`tutti_latency`), the stems' alike, so a render's frame 0 is the sound at `fromBeat`.
- **Every render plays from the start.** A render of `[fromBeat, toBeat)` renders from beat 0 (the transport started at
  frame 0, step 0 of every track there) and drops the frames before `fromBeat`, so notes held over `fromBeat`, delay and
  reverb tails, LFOs are as when the pattern plays through; a render of a later range is bit for bit the same audio as
  that part of a render from 0. A fresh instance per render (settled: the output level ramps up after a boot, 24 silent
  blocks before frame 0); fixed noise seeds, the probability generator seeded `0x6d2b79f5`, time only from rendered
  frames: two renders are the same bytes.
- **Tempo maps.** `tempoMap: "constant"`, as Felucca's: frame positions follow the host's map (section 5, linear ramps
  integrated); FM1 Open plays the range at the tempo in effect at `fromBeat`. A tempo change inside the range is refused
  (`unsupported`) unless the request says `approximation: "start-tempo"`.
- **Tempo range.** 30 .. 300 BPM (FM1 Open's own range, fractional within it); outside it `unsupported`.
- **No seek.** `capabilities.seek` is `false`: every render runs from beat 0, `render-progress` over the pre-roll and
  the range together. The pre-roll is capped at 610 s (the budget plus the longest tail), frames past 2^32 from beat 0
  are refused, a render holds at most 4800 credits (600 s x 8 outputs).

## Use A: what plays

A render with `input: null` plays the **working project's pattern** (the eight tracks as the state has them: steps,
chords, gates, probability, ties, p-locks, swing, arpeggiators, mute and solo), looped, from step 0 at frame 0, at the
host's tempo; the transport stops at `toBeat` (the nearest block start): the notes are let go there and the tail only
rings out. FM1 Open has 16 project slots but no song chain: a slot is played by loading it. A track set to send its
sequence to MIDI only (SEQ > MIDI TRACK) is silent, as on the FM1.

## Use B: the host's MIDI

With `input` the sequencer never runs (protocol 7b: only the host's MIDI plays; the state gives the sounds and
settings). For the render every track is a **PLAY track on its own MIDI channel** (`groove_track_role_set` /
`groove_midi_input_set` in the render's instance; the state keeps the user's roles and channels), so the manifest's
`midiChannels` is always right:

| MIDI channel (0-based) | Plays |
| --- | --- |
| 0 .. 7 | T1 .. T8 with their engines and sounds (DX7, 303, PSG, PLUCK: notes with velocity, pitch bend, the engines' CCs, CC 7 / 10 / 11, CC 64; the 808: GM drum notes 35 .. 56; the sampler: notes 36, 37, 38, 41, 42, 46, 47, 48) |
| 8 .. 15 | nothing |

A PLAY track is unmuted (as on the FM1), so T6 and T7, muted in a new FM1's project, play their channels too.

Notes are released at `min(end, toBeat)`; a note's off comes at least a block (128 frames) after its on, so a note of
length 0 (or less) still sounds and is let go, never off before on; moved that way, it still comes before the next note
of the same pitch on the same channel. A sustain pedal down over `toBeat` is let go there.

**Latches.** The arpeggiator's HOLD (ARP > HOLD) is off for the render (a runtime override in the render's instance;
the state keeps its setting), so a host note-off lets its note go and the arpeggiator plays only the notes the host
holds; at `toBeat` every channel gets its pedal up and all notes off (note-offs only: the releases and the effect tails
ring out). `plugin_test.mjs`: a state saved with ARP HOLD on two tracks renders the same bytes as without it, only a
decaying tail after the notes' end.

## Sample rates

The engine runs at 44.1 kHz only. `48000` is made from it by `resample.js` (Felucca's): a polyphase windowed sinc at the
exact ratio 160/147, 192 taps, centred on each output frame (no delay). A 1 kHz sine comes out within -120 dB.

## State

The full user state (`state.js`, `stateVersion` 1): the working project as the workbench exports it (the v4 project
of 4064 bytes and its 200-byte "FM1T" tuning tail, so edits not saved to a slot are in it), and every sector of the
flash that holds something (`sim_flash`, 536576 bytes: the 16 project slots and the device settings (MIDI, clock, the
slot loaded at power-on), the sample bank with the 8 user sample slots, the 4 DX7 library banks, the tuning sector with
the track roles and input channels), and the plugin's meta (none yet). Format: `"FM1P"`, u32 version, u32 meta length,
the meta (JSON), u32 project length (4264), the project, u32 count, then count x (u32 offset, 4096 bytes),
little-endian. A new FM1 is about 80 KiB (its demo sample bank); a full flash about 540 KiB, far under the host's 8 MiB.
An instance boots from it as the workbench restores a saved simulator (the flash, `sim_boot`), then imports the project
(`sim_import`). PLAY tracks' live timbre edits are not in a project, as on the FM1 (export a timbre file, or save DX7
voices to the library).

`plugin_test.mjs` checks the round trip: a project with tuning, a user sample in slot 1, a DX7 library bank written, a
device setting, an unsaved edit; packed, unpacked, booted in a fresh FM1: the same project bytes, the same flash byte for
byte, the same renders (mix and stems), the user sample and the tuning audible.

Revisions: 1 is the state `init` gave (without one: a new FM1's, made once). A change on the live FM1 (the state's
signature, `fm1_plugin.c tutti_sig`: the exported project and the flash's writes, checked every ~200 ms; not the host's
tempo, the transport, held notes) starts the next revision; `state-changed` follows once it has been still for 600 ms
(at most every 2 s while it keeps changing). A revision's state is made once (one snapshot, whoever asks for it while
it is made); renders take the state of the revision they ask for (the last 8 are kept). Device settings are written to
the flash 1.5 s after their last change (FM1 Open's own debounce): a setting changed then is in the revision after.

## Not done (yet)

- `tempoMap: "full"` (tempo changes inside a render): the clock would need the tempo per block.
- Sub-block timing (steps and MIDI to the frame): the engine's block is 128 frames.
- Web MIDI in tuttidaw's frame (the manifest asks no `midi` permission); the keys and the computer keyboard play the
  page's FM1.
- The workbench's device transfers (firmware update, project library, sample bank to an FM1 over USB MIDI).
