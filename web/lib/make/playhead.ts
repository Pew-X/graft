/**
 * The line that follows what is playing on the cut. The preview loops the rendered output, and a flip's
 * speed is constant, so the position in the loop maps linearly onto the cut: a fraction of the way
 * through the loop is the same fraction of the way through the kept part. Pure: no audio, no DOM.
 */
import type { Cut } from "./cut.ts";

/** How far through the loop a source has played, 0 up to (not including) 1, or null when nothing plays. */
export function loopFraction(elapsed: number, duration: number): number | null {
  if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || duration <= 0 || elapsed < 0) {
    return null;
  }
  const within = elapsed % duration;
  return within / duration;
}

/** The frame of the sound under the line: `start + fraction x (end - start)`, whichever way round the cut is. */
export function playheadFrame(cut: Cut, fraction: number): number {
  const lo = Math.min(cut.start, cut.end);
  const hi = Math.max(cut.start, cut.end);
  const f = Math.max(0, Math.min(1, fraction));
  return lo + f * (hi - lo);
}

/**
 * With reduced motion the line steps instead of gliding: it holds still for a quarter of the loop (at
 * most a fifth of a second would be a flicker, so the steps are fixed at four) and then jumps.
 */
export function steppedFraction(fraction: number, steps = 4): number {
  return Math.floor(Math.max(0, Math.min(0.999999, fraction)) * steps) / steps;
}
