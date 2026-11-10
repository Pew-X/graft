/**
 * The name a sketch gets when its maker types none. It follows the seeded chain's convention ("up a
 * fifth", "down an octave", "same pitch"): the direction first, then the interval, from the speed table. The
 * cut is added only when it is not the whole sound ("up a fifth, 0.4 to 0.9 s"), in seconds to two places
 * with trailing zeros trimmed. A name another sketch of the same parent already has gets " (2)", " (3)" and
 * so on. Only characters the service allows are ever used, so a default name always passes the title check.
 */
import { intervalPhrase, secondsText } from "../flips/describe.ts";
import { TITLE_LIMIT } from "./title.ts";

export function defaultTitle(input: {
  p: number;
  q: number;
  cut: { start: number; end: number };
  /** How long the sound being cut is, in frames; the cut is named unless it is all of it. */
  wholeFrames: number;
  /** Titles the same parent's other sketches already have. */
  taken: readonly string[];
}): string {
  let base = intervalPhrase(input.p, input.q);
  const whole = input.cut.start === 0 && input.cut.end === input.wholeFrames;
  if (!whole) base += `, ${secondsText(input.cut.start)} to ${secondsText(input.cut.end)} s`;
  const used = new Set(input.taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return [...base].slice(0, TITLE_LIMIT).join("");
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const room = TITLE_LIMIT - [...suffix].length;
    const candidate = `${[...base].slice(0, room).join("").trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
