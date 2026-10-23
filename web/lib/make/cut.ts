/**
 * The arithmetic of one cut and one speed, with the limits the service enforces (spec 4.2) so a flip
 * the service would refuse is refused here first, kindly, with the reason beside the button. The
 * service stays the authority; nothing here is trusted by it.
 */
import { copy, fill } from "../copy.ts";

export const LIMITS = {
  /** The shortest cut and the shortest output: 10 ms, so the two 5 ms fades never overlap. */
  minFrames: 480,
  /** The longest cut: 10 seconds. */
  maxCutFrames: 480_000,
  /** The longest output: 20 seconds. */
  maxOutputFrames: 960_000,
} as const;

/** The largest term of a speed ratio (2^20). */
const MAX_TERM = 1_048_576;

/** A cut in frames of the sound: the first frame kept, and the first frame after the last kept. */
export interface Cut {
  start: number;
  end: number;
}

export type Problem =
  | { kind: "cutShort" | "cutLong" | "cutInverted" | "cutOutside" }
  | { kind: "speedRange" | "speedTerms" }
  | { kind: "outputShort" | "outputLong" };

/** How many frames the renderer makes from a cut of `frames` at speed p/q: floor((L - 1) q / p) + 1. */
export function outputFrames(frames: number, p: number, q: number): number {
  const numerator = (frames - 1) * q; // at most 480,000 x 2^20: exact in a double
  return (numerator - (numerator % p)) / p + 1;
}

/** The first problem with a cut of a sound `sourceFrames` long, or null. */
export function checkCut(cut: Cut, sourceFrames: number): Problem | null {
  const { start, end } = cut;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > sourceFrames) {
    return { kind: "cutOutside" };
  }
  if (end <= start) return { kind: "cutInverted" };
  if (end - start < LIMITS.minFrames) return { kind: "cutShort" };
  if (end - start > LIMITS.maxCutFrames) return { kind: "cutLong" };
  return null;
}

/** The speed p/q is whole numbers up to 2^20 and between 1/4 and 4. */
export function checkSpeed(p: number, q: number): Problem | null {
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_TERM;
  if (!whole(p) || !whole(q)) return { kind: "speedTerms" };
  if (4 * p < q || p > 4 * q) return { kind: "speedRange" };
  return null;
}

/** The output length is within what the service stores. */
export function checkOutput(frames: number): Problem | null {
  if (frames < LIMITS.minFrames) return { kind: "outputShort" };
  if (frames > LIMITS.maxOutputFrames) return { kind: "outputLong" };
  return null;
}

/** The sentence that says why, in the voice of the piece. */
export function refusal(problem: Problem): string {
  return fill(copy.make.refusals[problem.kind], {
    min: LIMITS.minFrames,
    max: problem.kind === "outputLong" ? LIMITS.maxOutputFrames : LIMITS.maxCutFrames,
  });
}

/** The part of the sound a cut keeps: frames [start, end). */
export function cutSlice(source: Int16Array, cut: Cut): Int16Array {
  return source.slice(cut.start, cut.end);
}

/**
 * Move a boundary to the nearest zero crossing within `window` frames (the earlier one on a tie), so
 * a loop does not click on the way round. This is an editing aid only: the renderer's fades are the
 * real boundary treatment. A boundary with no crossing near it, as in silence, stays where it is.
 */
export function snapToZeroCrossing(samples: Int16Array, frame: number, window: number): number {
  const crosses = (i: number): boolean => {
    const before = samples[i - 1];
    const after = samples[i];
    if (before === undefined || after === undefined) return false;
    return (before < 0 && after >= 0) || (before > 0 && after <= 0);
  };
  if (crosses(frame)) return frame;
  for (let distance = 1; distance <= window; distance++) {
    if (crosses(frame - distance)) return frame - distance;
    if (crosses(frame + distance)) return frame + distance;
  }
  return frame;
}

/** Frames as seconds to the millisecond, for reading out a cut: "0.900". */
export function seconds(frames: number): string {
  return (frames / 48_000).toFixed(3);
}
