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
/** the longest cut the service accepts (30 s). */
export const MAX_FRAMES = 1_440_000;

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

/** Where the make page opens for a stage, with the part already marked, and its speed, when there are. */
export function makeAddress(
  id: string,
  cut?: { start: number; end: number } | null,
  speed?: { p: number; q: number } | null,
): string {
  const base = `/make?from=${encodeURIComponent(id)}`;
  const withCut = cut ? `${base}&cut=${cut.start}-${cut.end}` : base;
  return speed ? `${withCut}&speed=${encodeURIComponent(`${speed.p}/${speed.q}`)}` : withCut;
}

/** How long the marked part lasts, in seconds, for a stage of `frames`. */
export function markSeconds(mark: Mark, frames: number): number {
  return ((clamp01(mark.to) - clamp01(mark.from)) * Math.max(0, frames)) / RATE;
}

/** The speeds the record offers on a marked part: the only ones a restored cut may come back with. */
const OFFERED: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 3],
  [3, 2],
  [2, 1],
];

const place = (n: number): string => String(Math.round(clamp01(n) * 10_000) / 10_000);

/**
 * The marked part and its speed as the page's own address fragment (`#cut=3:0.25-0.75@3-2`), written as
 * the visitor leaves for the make page, so the browser's Back finds the cut still marked. Four decimals:
 * the same part to within a few frames.
 */
export function cutHash(mark: Mark, speed: { p: number; q: number } | null): string {
  const base = `#cut=${mark.stage}:${place(mark.from)}-${place(mark.to)}`;
  return speed ? `${base}@${speed.p}-${speed.q}` : base;
}

/**
 * A marked part read back from an address fragment, or null for anything that is not exactly what
 * `cutHash` writes: it comes from the address bar, so it is never trusted. A stage that is not in the
 * chain, places out of order or outside the stage, and a speed that is not one the record offers are
 * all refused (a bad speed alone loses the speed and keeps the part).
 */
export function parseCutHash(
  hash: string,
  stages: number,
): { mark: Mark; speed: { p: number; q: number } | null } | null {
  const found =
    /^#cut=(\d{1,2}):(0|1|0\.\d{1,4})-(0|1|0\.\d{1,4})(?:@([1-9]\d{0,6})-([1-9]\d{0,6}))?$/.exec(
      hash,
    );
  if (!found) return null;
  const stage = Number(found[1]);
  const from = Number(found[2]);
  const to = Number(found[3]);
  if (!Number.isInteger(stage) || stage >= stages || from > to) return null;
  const p = Number(found[4]);
  const q = Number(found[5]);
  const offered = OFFERED.some(([a, b]) => a === p && b === q);
  return { mark: { stage, from, to }, speed: offered ? { p, q } : null };
}
