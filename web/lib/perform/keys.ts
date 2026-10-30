/**
 * Which key plays which stage while the roll is performed. Keys are named by where they are on the
 * keyboard (`event.code`), never by the character a layout prints on them, so the number row plays the
 * same stages on an AZERTY or a QWERTZ keyboard: Digit1 to Digit9 are stages 1 to 9, Digit0 is 10, Minus is
 * 11 and Equal is 12. The service's deepest chain is 12 stages, source counted as the first, which is
 * exactly the number row. The numeric keypad plays 1 to 9 as well. A stage past 12 has a pad and no key.
 */

/** The positions that play a stage, in stage order. */
export const ROW = [
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

/** How many stages the keys can reach. */
export const MOST_PADS_BY_KEY = ROW.length;

/** The marks printed on those keys on the usual US layout, for a pad's corner when no better is known. */
const MARKS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="] as const;

/** The stage (counted from 0) a key position plays, or null for a key that plays none. */
export function padOfCode(code: string): number | null {
  const i = (ROW as readonly string[]).indexOf(code);
  if (i >= 0) return i;
  const pad = /^Numpad([1-9])$/.exec(code);
  return pad ? Number(pad[1]) - 1 : null;
}

/** What a pad's corner says about its key, by the US layout's marks; null for a stage with no key. */
export function keyOfPad(stage: number): string | null {
  return MARKS[stage] ?? null;
}

/** The part of a key event this decision reads, so it can be tested without a browser. */
export interface PadKey {
  code: string;
  repeat: boolean;
  isComposing: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Where the key went: a text field keeps its digits. */
  target: { tagName: string; isContentEditable?: boolean } | null;
}

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * The stage a key press plays, or null when it plays none: not a pad key, a stage this chain does not
 * have, a held key repeating, text being composed, any of control, meta, alt or shift held (browser and
 * assistive shortcuts: never ours), or typing in a field.
 */
export function padForKey(key: PadKey, stages: number): number | null {
  if (key.repeat || key.isComposing) return null;
  if (key.ctrlKey || key.metaKey || key.altKey || key.shiftKey) return null;
  if (key.target && (TYPING.has(key.target.tagName) || key.target.isContentEditable === true)) {
    return null;
  }
  const stage = padOfCode(key.code);
  return stage !== null && stage < stages ? stage : null;
}
