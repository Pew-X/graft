/**
 * Playback constants. The choreography numbers come from the spec (Appendix E); the three marked
 * "tuning" are first values that the builder tunes by ear later, so they are named constants and
 * not scattered numbers.
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

/** Tuning: overlap between the end of one step and the start of the next, in seconds. 0 = none. */
export const CROSSFADE = 0;
/** Tuning: per-stage gains for matching loudness across stages. Empty: every stage plays at 1. */
export const STAGE_GAINS: readonly number[] = [];
/** The gain applied to a stage. */
export const stageGain = (stage: number): number => STAGE_GAINS[stage] ?? 1;
/** Tuning: longest the teaser may last, in seconds, for a very short finished flip. */
export const TEASER_MAX_SECONDS = DWELL_MAX;
