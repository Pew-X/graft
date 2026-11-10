/**
 * One flip, described in facts the system computed and nothing else: how its speed moves the pitch, how
 * long it comes out, and how long ago it was published. The words follow the seeded chain's convention
 * ("up a fifth", "down an octave", "same pitch"): the direction first, then the interval. Titles and makers
 * are declared by people and are shown as typed elsewhere; nothing here is prose written about a flip.
 */
import { describeSpeed } from "../roll/speed.ts";

const SAMPLE_RATE = 48_000;

/** "up a fifth", "down an octave", "same pitch"; "up about a fifth" when the ratio sits off the interval. */
export function intervalPhrase(p: number, q: number): string {
  const { interval, approximate } = describeSpeed(p, q);
  if (interval === "same pitch") return approximate ? "about the same pitch" : interval;
  const match = interval.match(/^(.*) (up|down)$/);
  if (!match) return interval;
  const [, name, direction] = match;
  return `${direction} ${approximate ? "about " : ""}${name}`;
}

/** Seconds to at most two places, trailing zeros trimmed: 0.9, 1.5, 0.33. */
export function secondsText(frames: number): string {
  return String(Number((frames / SAMPLE_RATE).toFixed(2)));
}

/** "just now", "5 minutes ago", "3 days ago": the largest whole unit. */
export function ago(createdAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  const units: ReadonlyArray<readonly [string, number]> = [
    ["year", 365 * 86_400],
    ["month", 30 * 86_400],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, length] of units) {
    const n = Math.floor(seconds / length);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

export interface FlipFacts {
  speed: { p: number; q: number };
  frames: number;
  createdAtMs: number;
}

/** "up a fifth, 0.9 s, 3 days ago". */
export function describeFlip(flip: FlipFacts, nowMs: number): string {
  return [
    intervalPhrase(flip.speed.p, flip.speed.q),
    `${secondsText(flip.frames)} s`,
    ago(flip.createdAtMs, nowMs),
  ].join(", ");
}
