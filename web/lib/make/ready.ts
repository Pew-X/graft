/**
 * The cut and speed a visitor arrives with from the header's "make a flip" link: a ready-made flip of
 * the sound on the roll, so one tap on "hear it" gives sound within seconds. It keeps the start of the
 * sound (where the attack is) and plays it a fifth up, a ratio that is plainly different from the
 * source and still consonant with it (3/2; spec T1). A visitor who comes from a stage's own "flip this"
 * or from a marked part keeps their own cut and speed; this is only for the way in.
 */
import { LIMITS, outputFrames, type Cut } from "./cut.ts";

/** How much of the start is kept: 0.9 seconds at 48 kHz. */
const KEEP_FRAMES = 43_200;
export const READY_SPEED = { p: 3, q: 2 } as const;

/** The ready-made cut for a sound `frames` long, or null where the length is not known or too short to cut. */
export function readyCut(frames: number): Cut | null {
  if (!Number.isInteger(frames) || frames < LIMITS.minFrames * 2) return null;
  const end = Math.min(frames, KEEP_FRAMES, LIMITS.maxCutFrames);
  // the flip must itself be long enough to publish
  return outputFrames(end, READY_SPEED.p, READY_SPEED.q) >= LIMITS.minFrames
    ? { start: 0, end }
    : null;
}
