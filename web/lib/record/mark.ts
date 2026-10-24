/**
 * Marking a part of a stage on the record. The part is two places along one stage's groove, as
 * fractions of the stage's output (0 at the outer edge, 1 at the inner, as time runs on the record).
 * It becomes a cut for the make flow: whole frames at the renderer's rate, in the same terms the make
 * page already reads from its address (`cut=<start>-<end>`). Nothing here sounds or draws.
 */

export interface Mark {
  /** The stage the part is in (its slot on the record). */
  stage: number;
  /** Two places in it, 0 to 1; `from` is never after `to`. */
  from: number;
  to: number;
}

const RATE = 48_000;
/** the smallest cut the renderer accepts (480 frames, 10 ms): a mark shorter than this is a tap, not a part. */
export const MIN_FRAMES = 480;
/** the longest cut the renderer accepts (10 s). */
export const MAX_FRAMES = 480_000;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** A mark between two places in a stage, put in order and kept inside the stage. */
export function markBetween(stage: number, a: number, b: number): Mark {
  const x = clamp01(a);
  const y = clamp01(b);
  return { stage, from: Math.min(x, y), to: Math.max(x, y) };
}

/**
 * The mark as a cut in whole frames of a stage whose audio is `frames` long, or null when it is too
 * short to be a part. A mark longer than the renderer accepts is shortened to its limit from the start,
 * so the cut is always one the make page will accept.
 */
export function markFrames(mark: Mark, frames: number): { start: number; end: number } | null {
  if (!Number.isFinite(frames) || frames < MIN_FRAMES) return null;
  const start = Math.round(clamp01(mark.from) * frames);
  const end = Math.min(frames, Math.round(clamp01(mark.to) * frames), start + MAX_FRAMES);
  return end - start >= MIN_FRAMES ? { start, end } : null;
}

/** Where the make page opens for a stage, with the part already marked when there is one. */
export function makeAddress(id: string, cut?: { start: number; end: number } | null): string {
  const base = `/make?from=${encodeURIComponent(id)}`;
  return cut ? `${base}&cut=${cut.start}-${cut.end}` : base;
}

/** How long the marked part lasts, in seconds, for a stage of `frames`. */
export function markSeconds(mark: Mark, frames: number): number {
  return ((clamp01(mark.to) - clamp01(mark.from)) * Math.max(0, frames)) / RATE;
}
