/**
 * Playback constants. The choreography numbers come from the spec (Appendix E). The per-stage gains
 * are a tuning hook: empty for now, edited by ear later. Two further knobs the spec lists as tuning
 * items, a cross-fade at a stage change and a cap on the teaser for a very short finished flip, are
 * not implemented: they wait for the listening pass (ticket 25) and would be added with their effect.
 */

/** Canonical audio: 48 kHz mono signed 16-bit. */
export const SAMPLE_RATE = 48_000;

/** The longest a step lasts, in seconds. */
export const DWELL_MAX = 2.4;
/** The shortest a step lasts, in seconds, however long the chain is. */
export const DWELL_MIN = 1.6;
/** A whole roll should last about this long, so each step lasts this divided by the stage count. */
export const ROLL_TARGET_SECONDS = 20;

/** Silence between repeats of the stage that is in focus, in seconds. */
export const REPEAT_GAP = 0.05;
/** Fade-in at the start of every repeat, in seconds. */
export const ATTACK = 0.006;
/** Fade-out when a sound is released, in seconds. */
export const RELEASE = 0.02;

/** Tuning: per-stage gains for matching loudness across stages. Empty: every stage plays at 1. */
export const STAGE_GAINS: readonly number[] = [];
/** The gain applied to a stage. */
export const stageGain = (stage: number): number => STAGE_GAINS[stage] ?? 1;
