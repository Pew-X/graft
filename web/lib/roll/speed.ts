/**
 * A speed ratio p/q, said two ways: as a percentage of the original speed, and as the musical
 * interval it moves the pitch by (varispeed changes both together). The interval is the nearest
 * tempered one, and is marked approximate when the ratio is more than ten cents away from it.
 */

const NAMES = [
  "same pitch",
  "a half step",
  "a whole step",
  "a minor third",
  "a major third",
  "a fourth",
  "a tritone",
  "a fifth",
  "a minor sixth",
  "a major sixth",
  "a minor seventh",
  "a major seventh",
];
const OCTAVES = ["", "an octave", "two octaves", "three octaves", "four octaves"];
/// Further than this from a tempered interval (in cents) the interval is only approximate.
const EXACT_WITHIN_CENTS = 10;

export interface Speed {
  /** "150%". */
  percent: string;
  /** "a fifth up", "an octave down", "same pitch". */
  interval: string;
  /** Whether the ratio sits more than ten cents from the interval named. */
  approximate: boolean;
}

function name(semitones: number): string {
  const octaves = Math.floor(semitones / 12);
  const rest = semitones % 12;
  const octaveText = OCTAVES[octaves] ?? `${octaves} octaves`;
  if (octaves === 0) return NAMES[rest] ?? "";
  return rest === 0 ? octaveText : `${octaveText} and ${NAMES[rest]?.replace(/^an? /, "a ")}`;
}

export function describeSpeed(p: number, q: number): Speed {
  if (!Number.isInteger(p) || !Number.isInteger(q) || p < 1 || q < 1) {
    throw new RangeError(`a speed is a ratio of two positive whole numbers, got ${p}/${q}`);
  }
  const semitones = 12 * Math.log2(p / q);
  const nearest = Math.round(semitones);
  const apart = Math.abs(nearest);
  const approximate = Math.abs(semitones - nearest) * 100 > EXACT_WITHIN_CENTS;
  const interval = apart === 0 ? name(0) : `${name(apart)} ${nearest > 0 ? "up" : "down"}`;
  return { percent: `${Math.round((p / q) * 100)}%`, interval, approximate };
}
