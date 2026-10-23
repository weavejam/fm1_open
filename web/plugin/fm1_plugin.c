/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 weavejam
 *
 * FM1 Open for tuttidaw (protocol tutti-plugin/0, web/plugin/README.md): FM1 Open's browser engine (the same sources
 * tools/Build-Web.ps1 compiles: web/engine, web/synth, third_party/synth, app/ without app/board, headers from
 * sdk/include; never the binary SDK in sdk/lib), built with FM1_TUTTI and this file, in two roles:
 *   - the device of the plugin page (an AudioWorklet, worklet-tutti.js): the workbench's simulator (sim_* exports of
 *     web/engine/Simulator.c: panel, screen, keys, projects, samples) plus the host's tempo, its transport (preview,
 *     tutti_live_*), the clock kept internal, the state's signature (tutti_sig);
 *   - a headless render (renderer.js, one fresh instance per render): the project's pattern started at frame 0
 *     (use A) or the host's MIDI at frames (use B: every track a PLAY track on its own channel, the sequencer never
 *     started), blocks of 128 frames into a float mix and each track's share of it (fm1_tutti_cap) for its stem;
 *   - a track's stem (tutti_stem_render, in an instance of its own: its own reverb and delay, the mix's limiter gain).
 * The engine renders blocks of FM1_BLOCK_FRAMES (128) frames only (DX7 voices, the mixer, the buses): events are
 * taken per block (README "Timing"). sim_render gives the block before the one it renders: one block of latency,
 * which the renderer drops (tutti_latency).
 *   web/plugin/build.mjs  ->  build/plugin-wasm/fm1open.wasm */
#include "internal.h"
#include "mixer.h"
#include "fixed.h"
#include <string.h>

#define EXPORT(name) __attribute__((export_name(name)))

/* web/engine/Simulator.c */
void sim_boot(unsigned clear);
const float *sim_render(void);
uint8_t *sim_file(void);
int sim_export(void);

enum { B = FM1_BLOCK_FRAMES, TT_MAXB = 64 };            /* a block; the blocks a call renders at most (8192 frames) */

/* ------------------------------------------------------------------ the role */
/* before sim_boot: a headless render (no click), and whether the page is hosted (the clock kept internal: the host's
 * tempo drives it; the saved clock setting stays as it is) */
EXPORT("tutti_prepare") void tutti_prepare(unsigned headless, unsigned hosted)
{
    fm1_tutti_no_click = headless != 0;
    fm1_tutti_clock_internal = hosted != 0 || headless != 0;
    if (fm1_tutti_clock_internal) groove_clock_set(GROOVE_CLOCK_INTERNAL);
}

/* ------------------------------------------------------------------ the tempo */
/* the host's tempo, FM1's range (30 .. 300 BPM), fractional; a runtime value (the project's tempo stays its own, so
 * the host's tempo never changes the state). 1 = set; 0 = outside the range (nothing changed); 0 BPM: none */
#define TUTTI_BPM_MIN 30.0
#define TUTTI_BPM_MAX 300.0
EXPORT("tutti_bpm_min") double tutti_bpm_min(void) { return TUTTI_BPM_MIN; }
EXPORT("tutti_bpm_max") double tutti_bpm_max(void) { return TUTTI_BPM_MAX; }
EXPORT("tutti_tempo") unsigned tutti_tempo(double bpm)
{
    if (bpm == 0.0) {
        fm1_tutti_bpm_q32 = 0;
        return 1;
    }
    if (!(bpm >= TUTTI_BPM_MIN && bpm <= TUTTI_BPM_MAX)) return 0;
    fm1_tutti_bpm_q32 = (uint64_t)(bpm * 4294967296.0 + 0.5);
    return 1;
}

/* the clock units a block advances (sequencer.c: tempo x 4 a frame) */
static uint32_t block_units(void)
{
    return fm1_tutti_bpm_q32 ? (uint32_t)((fm1_tutti_bpm_q32 * (4u * FM1_BLOCK_FRAMES)) >> 32)
                             : groove_tempo_saved() * 4u * FM1_BLOCK_FRAMES;
}

/* ------------------------------------------------------------------ what the pattern takes */
static unsigned gcd(unsigned a, unsigned b) { while (b) { unsigned t = a % b; a = b; b = t; } return a; }
/* sixteenths until the whole pattern repeats: the least common multiple of the lengths (16, 32, 48 or 64 steps) of
 * the tracks the sequencer plays (role NORMAL); at most 192 */
EXPORT("tutti_pattern_steps") unsigned tutti_pattern_steps(void)
{
    unsigned l = 16;
    for (unsigned t = 0; t < GROOVE_TRACKS; ++t)
        if (groove_track_role(t) == GROOVE_TRACK_NORMAL) {
            unsigned n = groove_sequence_length(t);
            if (n) l = l / gcd(l, n) * n;
        }
    return l;
}

/* ------------------------------------------------------------------ the headless render */
static uint32_t tt_frame;                                /* frames rendered since tutti_start / tutti_use_b (blocks) */
static uint32_t tt_stop = ~0u, tt_end = ~0u;             /* use A: the transport's stop; use B: everything let go */
static float tt_l[TT_MAXB * B], tt_r[TT_MAXB * B];
static int32_t tt_cap[GROOVE_TRACKS][TT_MAXB][4][B];     /* each track's dry L, R, reverb and delay sends per block */
static int32_t tt_gain[TT_MAXB][2];                      /* the mix's master limiter gain (Q30), its output level */
static void send3(unsigned status, unsigned d1, unsigned d2)
{
    uint8_t m[3] = {(uint8_t)status, (uint8_t)(d1 & 127u), (uint8_t)(d2 & 127u)};
    unsigned n = (status & 0xf0u) == 0xc0u || (status & 0xf0u) == 0xd0u ? 2u : status >= 0xf0u ? 1u : 3u;
    fm1_web_midi(m, n);
}
/* after sim_boot (and the workspace imported): blocks until the output gain stands where MASTER is (it ramps from 0
 * after a boot), nothing playing; at MASTER's top for a render */
EXPORT("tutti_settle") void tutti_settle(void)
{
    for (unsigned i = 0; i < 24u; ++i) (void)sim_render();
    tt_frame = 0;
}
/* use A: the transport starts with the next block (step 0 of every track at its frame 0), and stops with the block
 * nearest to frame `stop` (toBeat: the notes let go there, the tail only rings out; ~0u: never) */
EXPORT("tutti_start") void tutti_start(uint32_t stop)
{
    /* half a block of clock units ahead: a step sounds at the block start nearest to its time (within 64 frames), not
     * the next one (0 .. 127 frames late, as on the FM1); step 0 at frame 0 all the same */
    fm1_tutti_start_phase = (uint32_t)((block_units() + 1u) / 2u);
    send3(0xfa, 0, 0);
    fm1_tutti_start_phase = 0;
    tt_stop = stop;
    tt_frame = 0;
}

/* use B: MIDI at frames from frame 0, in time order, each taken with the block whose start is nearest (within 64
 * frames). Every track plays as a PLAY track on its own MIDI channel (0..7 -> T1..T8), its sound as the state has it,
 * unmuted; the sequencer never starts; ARP HOLD off for the render (the host's note lifetimes win; the state keeps
 * its setting). At `stop` (toBeat) every note, the pedals and the arpeggiators are let go (note-offs only: releases
 * and the reverb and delay ring out) */
#define TT_NEV 65536u
static struct { uint32_t frame; uint8_t st, d1, d2; } tt_ev[TT_NEV];
static uint32_t tt_nev, tt_evr;
EXPORT("tutti_event") unsigned tutti_event(uint32_t frame, unsigned status, unsigned d1, unsigned d2)
{
    if (tt_nev >= TT_NEV || status < 0x80u || status >= 0xf0u) return 0;
    tt_ev[tt_nev].frame = frame;
    tt_ev[tt_nev].st = (uint8_t)status;
    tt_ev[tt_nev].d1 = (uint8_t)(d1 & 127u);
    tt_ev[tt_nev].d2 = (uint8_t)(d2 & 127u);
    tt_nev++;
    return 1;
}
static void tt_unhold(void)
{
    for (unsigned t = 0; t < GROOVE_TRACKS; ++t)
        if (groove_arp_setting(t, 5)) groove_arp_edit(t, 5, -1);
}
EXPORT("tutti_use_b") int tutti_use_b(uint32_t stop)
{
    for (unsigned t = 0; t < GROOVE_TRACKS; ++t) {
        int r = groove_track_role_set(t, GROOVE_TRACK_PLAY);
        if (!r) r = groove_midi_input_set(t, t);
        if (r) return r;
    }
    tt_unhold();
    tt_end = stop;
    tt_frame = 0;
    return 0;
}
static void tt_release_all(void)
{
    for (unsigned ch = 0; ch < GROOVE_TRACKS; ++ch) {
        send3(0xb0u | ch, 64, 0);                        /* the pedal up */
        send3(0xb0u | ch, 123, 0);                       /* all notes off: held keys and the arpeggiator let go */
    }
}
static void tt_events(uint32_t f0)
{
    while (tt_evr < tt_nev && tt_ev[tt_evr].frame < f0 + B / 2u) {
        send3(tt_ev[tt_evr].st, tt_ev[tt_evr].d1, tt_ev[tt_evr].d2);
        tt_evr++;
        tt_unhold();                                     /* (nothing sets HOLD from MIDI today: kept off all the same) */
    }
}
/* nblocks (<= TT_MAXB) blocks into tutti_out_l / _r (the mix, a block late: tutti_latency); capture: each track's
 * share too (tutti_cap) and the mix's gains (tutti_gain), of the block rendered now (the stems make up the block of
 * latency themselves, tutti_stem_render) */
EXPORT("tutti_render") void tutti_render(unsigned nblocks, unsigned capture)
{
    if (nblocks > TT_MAXB) nblocks = TT_MAXB;
    fm1_tutti_capture = capture != 0;
    for (unsigned b = 0; b < nblocks; ++b) {
        uint32_t f0 = tt_frame;
        tt_events(f0);
        if (tt_end != ~0u && f0 + B / 2u > tt_end) {
            tt_release_all();
            tt_end = ~0u;
        }
        if (tt_stop != ~0u && f0 + B / 2u > tt_stop) {
            send3(0xfc, 0, 0);
            tt_stop = ~0u;
        }
        const float *o = sim_render();
        for (unsigned i = 0; i < B; ++i) {
            tt_l[b * B + i] = o[2 * i];
            tt_r[b * B + i] = o[2 * i + 1];
        }
        if (capture) {
            for (unsigned t = 0; t < GROOVE_TRACKS; ++t) memcpy(tt_cap[t][b], fm1_tutti_cap[t], sizeof tt_cap[t][b]);
            tt_gain[b][0] = (int32_t)fm1_master_gain();
            tt_gain[b][1] = (int32_t)fm1_engine_output_level();
        }
        tt_frame += B;
    }
}
EXPORT("tutti_out_l") float *tutti_out_l(void) { return tt_l; }
EXPORT("tutti_out_r") float *tutti_out_r(void) { return tt_r; }
EXPORT("tutti_cap") int32_t *tutti_cap(unsigned track) { return &tt_cap[track % GROOVE_TRACKS][0][0][0]; }
EXPORT("tutti_gain") int32_t *tutti_gain(void) { return &tt_gain[0][0]; }
EXPORT("tutti_block_frames") unsigned tutti_block_frames(void) { return B; }
EXPORT("tutti_max_blocks") unsigned tutti_max_blocks(void) { return TT_MAXB; }
/* frames from an event to its sound at the output: sim_render's block of latency. An event (a step, a MIDI message)
 * is taken at a block's start (README "Timing") */
EXPORT("tutti_latency") unsigned tutti_latency(void) { return B; }
/* the sequencer, for the tests: sixteenths since the start, clock units into the next one, playing */
EXPORT("tutti_ticks") uint32_t tutti_ticks(void) { return fm1_tutti_ticks; }
EXPORT("tutti_phase") uint32_t tutti_phase(void) { return fm1_tutti_phase(); }
EXPORT("tutti_playing") unsigned tutti_playing(void)
{
    struct groove_view v;
    groove_sequence_view(0, 0, &v);
    return v.playing;
}

/* ------------------------------------------------------------------ a stem */
/* In an instance of its own (booted with the same state at the same tempo, settled likewise): one track's share
 * (tutti_cap's layout and tutti_gain's, copied into tutti_bus_in / tutti_gain_in) through this instance's reverb and
 * delay (fm1_fx_render: fed by this track's sends only), added to its dry share, then as the mix: the bus output, the
 * mix's master limiter gain of that block (the mix's, not its own: a stem is as loud as its track is in the limited
 * mix), the output level, the 24-bit limit; a block late as sim_render gives the mix */
static int32_t tt_bus[TT_MAXB][4][B], tt_bgain[TT_MAXB][2];
static float tt_sl[TT_MAXB * B], tt_sr[TT_MAXB * B], tt_dl[B], tt_dr[B];
EXPORT("tutti_bus_in") int32_t *tutti_bus_in(void) { return &tt_bus[0][0][0]; }
EXPORT("tutti_gain_in") int32_t *tutti_gain_in(void) { return &tt_bgain[0][0]; }
EXPORT("tutti_stem_l") float *tutti_stem_l(void) { return tt_sl; }
EXPORT("tutti_stem_r") float *tutti_stem_r(void) { return tt_sr; }
static int32_t limit24(int64_t v) { return v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : (int32_t)v; }
EXPORT("tutti_stem_render") void tutti_stem_render(unsigned nblocks)
{
    static int32_t l[B], r[B], out[2 * B];
    if (nblocks > TT_MAXB) nblocks = TT_MAXB;
    for (unsigned b = 0; b < nblocks; ++b) {
        int32_t (*s)[B] = tt_bus[b], g = tt_bgain[b][0], og = tt_bgain[b][1];
        memcpy(l, s[0], sizeof l);
        memcpy(r, s[1], sizeof r);
        fm1_fx_render(l, r, s[2], s[3]);
        fm1_bus_output128(out, l, r);
        for (unsigned i = 0; i < 2u * B; ++i) {         /* web/synth/mixer.c fm1_master_process128's gain */
            int32_t x = out[i];
            if (g == INT32_MAX) x = x * 2 - (x > 0) + (x < 0);
            else if (g != FM_Q30_ONE) x = (int32_t)(((int64_t)x * g) / FM_Q30_ONE);
            out[i] = limit24(((int64_t)x * og) >> 7);    /* app/audio_output.c fm1_output_mix (no USB / Bluetooth) */
        }
        for (unsigned i = 0; i < B; ++i) {
            tt_sl[b * B + i] = tt_dl[i];
            tt_sr[b * B + i] = tt_dr[i];
            tt_dl[i] = (float)out[2 * i] * (1.0f / 8388608.0f);
            tt_dr[i] = (float)out[2 * i + 1] * (1.0f / 8388608.0f);
        }
    }
}

/* ------------------------------------------------------------------ the live page */
/* the host's transport for the page's preview (listen-only): playing from `sixteenths` after the start (the swing's
 * pairs as the sequencer times them), or stopped. The sequencer is placed there at once (no catching up): the step
 * under way does not sound, the next one does */
EXPORT("tutti_live_play") void tutti_live_play(double sixteenths)
{
    if (!(sixteenths >= 0.0)) sixteenths = 0.0;
    if (!tutti_playing()) send3(0xfa, 0, 0);
    const double period = FM1_SAMPLE_RATE * 60.0;          /* clock units in a sixteenth (sequencer.c PERIOD) */
    unsigned swing = groove_sequence_setting(0);
    double units = sixteenths * period, pair = 2.0 * period, even = period / 100.0 * (100.0 + swing);
    double pairs = (double)(uint64_t)(units / pair), into = units - pairs * pair;
    uint32_t ticks = (uint32_t)pairs * 2u;
    if (into >= even) { ticks++; into -= even; }
    fm1_tutti_locate(ticks, (uint32_t)into, into < (double)block_units());   /* (a step just begun: it sounds) */
}
EXPORT("tutti_live_stop") void tutti_live_stop(void)
{
    if (tutti_playing()) send3(0xfc, 0, 0);
}
/* the sixteenths since the start where the sequencer is now (the preview's drift check) */
EXPORT("tutti_live_pos") double tutti_live_pos(void)
{
    const double period = FM1_SAMPLE_RATE * 60.0;
    unsigned swing = groove_sequence_setting(0);
    uint32_t ticks = fm1_tutti_ticks;
    double base = (double)(ticks / 2u) * 2.0 + ((ticks & 1u) ? (100.0 + swing) / 100.0 : 0.0);
    return base + fm1_tutti_phase() / period;
}

/* ------------------------------------------------------------------ the state's signature */
/* what the state is (a change: a new revision): the working project as exported (the pattern, the sounds, the mix,
 * the effects, the tuning) and the flash's writes (saved projects, settings, the sample bank, the DX7 library). Not
 * the host's tempo, the transport, held notes */
extern uint32_t sim_flash_revision(void);
static uint32_t sig_mix(uint32_t h, const uint8_t *p, unsigned n)
{
    while (n--) h = (h ^ *p++) * 16777619u;
    return h;
}
EXPORT("tutti_sig") uint32_t tutti_sig(void)
{
    uint32_t h = 2166136261u, rev = sim_flash_revision();
    if (!sim_export()) h = sig_mix(h, sim_file(), GROOVE_PROJECT_TUNED_BYTES);
    return sig_mix(h, (const uint8_t *)&rev, sizeof rev);
}
