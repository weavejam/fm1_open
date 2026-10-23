/* SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception */
#ifndef FM1_WEB_INTERNAL_H
#define FM1_WEB_INTERNAL_H
#include "instrument.h"
#include "fm1_engine_control.h"
void fm1_web_init(void);
void fm1_web_tick(void);
void fm1_web_control(void);
void fm1_web_midi(const uint8_t *message, size_t bytes);
void fm1_web_pause(void);
void fm1_web_resume(void);
FM1_DSP_CODE void groove_note(unsigned track, unsigned note, unsigned velocity, int sequenced);
/* groove_note with an explicit alt flag (GROOVE_STEP_ALT); selects the alt tuning table. */
FM1_DSP_CODE void groove_note_ex(unsigned track, unsigned note, unsigned velocity, int sequenced, unsigned alt);
FM1_DSP_CODE unsigned groove_alt_held(unsigned track);
void groove_sequence_alt(unsigned track, unsigned step, unsigned alt);
FM1_DSP_CODE void groove_arp_reset(unsigned clear_latch);
FM1_DSP_CODE void groove_arp_render(unsigned tempo);
FM1_DSP_CODE void groove_arp_clock(void);
FM1_DSP_CODE void groove_sequence_render(void);
FM1_DSP_CODE void groove_sequence_transport(uint8_t status);
FM1_DSP_CODE void groove_sequence_clock(void);
FM1_DSP_CODE void groove_sequence_position(unsigned position);
FM1_DSP_CODE void groove_record_midi(const uint8_t *message, size_t bytes);
FM1_DSP_CODE void groove_edit_midi_changed(void);
FM1_DSP_CODE void groove_sequence_click(int32_t *output, unsigned frames);
FM1_DSP_CODE void groove_lock_apply(unsigned track, unsigned parameter, unsigned value);
FM1_DSP_CODE void groove_lock_restore(unsigned track);
#ifdef FM1_TUTTI
/* tuttidaw plugin build only (web/plugin/fm1_plugin.c, web/plugin/README.md). The host's tempo as BPM in Q32
 * (0: the project's own tempo); a runtime value, never saved. The sequencer, the arpeggiator and the synced delay
 * follow it, a block's fraction of a clock unit carried to the next block. */
extern uint64_t fm1_tutti_bpm_q32;
/* 1: the clock stays internal whatever is set (groove_clock_set); the saved setting is kept. */
extern unsigned fm1_tutti_clock_internal;
/* Sequencer ticks (sixteenths) since the transport started, and the phase in clock units (for tests). */
extern uint32_t fm1_tutti_ticks;
uint32_t fm1_tutti_phase(void);
/* Place the running transport at tick `ticks`, `phase` clock units into it (the live preview's seek); `arm`: the
 * step at `ticks` sounds with the next block (placed just past its start). */
void fm1_tutti_locate(uint32_t ticks, uint32_t phase, unsigned arm);
/* The clock's phase at a transport start (renders: half a block, so steps take the nearest block start). */
extern uint32_t fm1_tutti_start_phase;
/* 1: each track's share of the mix is captured per block (fm1_tutti_cap: dry left, dry right, reverb send, delay
 * send, after the track's gain, pan, mute and LFO), the mix itself unchanged. */
extern unsigned fm1_tutti_capture;
extern int32_t fm1_tutti_cap[GROOVE_TRACKS][4][FM1_BLOCK_FRAMES];
/* 1: no metronome click (renders). */
extern unsigned fm1_tutti_no_click;
/* A PLAY track's live arpeggiator settings, mute and solo from a raw capture's row (groove_project_capture; the
 * timbre: groove_timbre_apply). The state's live session (fm1_plugin.c tutti_session_apply). */
int fm1_tutti_play_row(unsigned track, const struct groove_project *p);
#endif
#endif
