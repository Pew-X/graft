/**
 * The make flow's run of hints as a small state machine, in the same spirit as the roll's guide: one
 * line at a time, each goes when the visitor does the thing it says, and then nothing is left.
 *
 *   pick     "pick any sound. you cut a piece of it next."
 *   hear     "this flip is already set up. press hear it."
 *   change   "now move a bracket or the speed, and hear it change."
 *   share    "like it? publish it with the button below."
 *   done     nothing is shown
 */
export type MakePhase = "pick" | "hear" | "change" | "share" | "done";

export type MakeEvent =
  /** A sound is in the editor. */
  | "picked"
  /** The visitor pressed hear it, or moved a control, which starts the sound. */
  | "heard"
  /** The visitor moved a bracket or the speed. */
  | "changed"
  /** The visitor opened the publish step. */
  | "shared"
  /** The last line went away by itself. */
  | "faded"
  | "skipped";

export function next(phase: MakePhase, event: MakeEvent): MakePhase {
  if (phase === "done") return phase;
  if (event === "skipped") return "done";
  switch (phase) {
    case "pick":
      return event === "picked" ? "hear" : phase;
    case "hear":
      // a visitor who moves a control has already heard it; one who publishes has done it all
      return event === "heard"
        ? "change"
        : event === "changed"
          ? "share"
          : event === "shared"
            ? "done"
            : phase;
    case "change":
      return event === "changed" ? "share" : event === "shared" ? "done" : phase;
    case "share":
      return event === "shared" || event === "faded" ? "done" : phase;
  }
}

/** Where a replay begins: at the picker, or, with a sound already in the editor, at hear it. */
export function replayAt(hasSound: boolean): MakePhase {
  return hasSound ? "hear" : "pick";
}
