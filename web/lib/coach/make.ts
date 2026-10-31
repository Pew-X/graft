/**
 * The make flow's run of hints as a small state machine, in the same spirit as the roll's guide: one
 * line at a time, each goes when the visitor does the thing it says, and then nothing is left. The whole
 * path, in order, is the path of the product:
 *
 *   pick      pick a sound
 *   hear      hear the ready-made flip
 *   change    move a bracket or the speed
 *   keep      keep a try as a sketch
 *   another   keep another try, or go on from a sketch
 *   pads      put two sketches on pads and play them together
 *   publish   publish the ones worth keeping
 *   next      after a publish, flip the next one from it
 *   done      nothing is shown
 *
 * Doing a later thing first skips the lines in between, and nothing goes back. The state is its own word,
 * kept under its own key (see sketch-guide.ts): it is never a value of the roll's guide, whose reader would
 * start the first-visit narration again for a word it does not know.
 */
export const PHASES = [
  "pick",
  "hear",
  "change",
  "keep",
  "another",
  "pads",
  "publish",
  "next",
  "done",
] as const;
export type MakePhase = (typeof PHASES)[number];

export type MakeEvent =
  /** A sound is in the editor. */
  | "picked"
  /** The visitor pressed hear it, or moved a control, which starts the sound. */
  | "heard"
  /** The visitor moved a bracket or the speed. */
  | "changed"
  /** The visitor kept a try as a sketch. */
  | "kept"
  /** The visitor went on from a sketch (the next sketch starts from its sound). */
  | "wentOn"
  /** The visitor put a sketch on the bank. */
  | "banked"
  /** The visitor published: one flip, or a set. */
  | "published"
  /** The last line went away by itself. */
  | "faded"
  | "skipped";

const at = (phase: MakePhase): number => PHASES.indexOf(phase);

export function next(
  phase: MakePhase,
  event: MakeEvent,
  /** Whether the sketch bank is on this page: a build that holds perform back has no pads to point at. */
  bank = true,
): MakePhase {
  if (phase === "done") return phase;
  if (event === "skipped") return "done";
  const afterAnother: MakePhase = bank ? "pads" : "publish";
  switch (event) {
    case "picked":
      return phase === "pick" ? "hear" : phase;
    case "heard":
      return phase === "hear" ? "change" : phase;
    case "changed":
      // a visitor who moves a control has already heard it
      return phase === "hear" || phase === "change" ? "keep" : phase;
    case "kept":
      if (at(phase) < at("another")) return "another";
      return phase === "another" ? afterAnother : phase;
    case "wentOn":
      return at(phase) <= at("another") ? afterAnother : phase;
    case "banked":
      return at(phase) <= at("pads") ? "publish" : phase;
    case "published":
      return at(phase) <= at("publish") ? "next" : phase;
    case "faded":
      return phase === "next" ? "done" : phase;
  }
}

/** Where a replay begins: at the picker, or, with a sound already in the editor, at hear it. */
export function replayAt(hasSound: boolean): MakePhase {
  return hasSound ? "hear" : "pick";
}
