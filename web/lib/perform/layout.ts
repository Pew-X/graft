/**
 * What is printed on the keys that play the stages, where the browser can say (Chromium's keyboard map),
 * and a plain position hint where it cannot. The keys themselves are named by position, so what is printed
 * only labels a pad's corner: it can never change which stage a key plays.
 */
import { MOST_PADS_BY_KEY } from "./keys.ts";

const CODES = [
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
  "Minus",
  "Equal",
] as const;

/** The part of `navigator.keyboard` this reads. */
export interface KeyboardLike {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

/**
 * The mark printed on each pad's key, by stage number from 0: only the keys whose printing is one visible
 * character (a dead key or a name such as "Dead" is left out). Null when the browser cannot say.
 */
export async function printedMarks(
  keyboard: KeyboardLike | undefined,
): Promise<Record<number, string> | null> {
  if (!keyboard?.getLayoutMap) return null;
  try {
    const map = await keyboard.getLayoutMap();
    const out: Record<number, string> = {};
    CODES.forEach((code, stage) => {
      const mark = map.get(code);
      if (mark !== undefined && [...mark].length === 1 && mark.trim() !== "") out[stage] = mark;
    });
    return out;
  } catch {
    return null;
  }
}

const ORDINAL = ["1st", "2nd", "3rd"];

/** "top row, 11th key": where a pad's key is, for a browser that cannot print it. Null past the number row. */
export function positionHint(stage: number): string | null {
  if (stage < 0 || stage >= MOST_PADS_BY_KEY) return null;
  return `top row, ${ORDINAL[stage] ?? `${stage + 1}th`} key`;
}
