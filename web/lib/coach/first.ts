/**
 * The first-visit guide as a small state machine: a narrated first play, then two hints, one at a time,
 * then nothing. It is pure, so the order and the "once" can be checked without a browser.
 *
 *   armed        nothing has been shown; the first play will be narrated
 *   narrating    the captions are following the roll
 *   hintNeedle   "drag the needle to hear any moment."
 *   hintMark     "like a part? mark it, change its speed, flip it."
 *   done         everything has been shown; nothing comes back until the footer replays it
 */
export type Phase = "armed" | "narrating" | "hintNeedle" | "hintMark" | "done";

export type Event =
  /** The roll began to sound. */
  | "rolled"
  /** The visitor took over: dragged the needle, tapped a ring, pressed next or previous. */
  | "tookOver"
  /** The last caption has been read. */
  | "narrationEnded"
  | "skipped"
  /** The visitor dragged the needle (the first hint has been done). */
  | "needleUsed"
  /** The visitor marked a part (the second hint has been done). */
  | "marked"
  /** A hint went away by itself. */
  | "hintFaded"
  /** "how it works" in the footer. */
  | "replay";

export function next(phase: Phase, event: Event): Phase {
  if (event === "replay") return "narrating";
  switch (phase) {
    case "armed":
      // A visitor who starts with the needle has found it already: no narration, on to the hints.
      return event === "rolled" ? "narrating" : event === "tookOver" ? "hintNeedle" : phase;
    case "narrating":
      return event === "tookOver" || event === "skipped" || event === "narrationEnded"
        ? "hintNeedle"
        : phase;
    case "hintNeedle":
      return event === "needleUsed" || event === "hintFaded" ? "hintMark" : phase;
    case "hintMark":
      return event === "marked" || event === "hintFaded" ? "done" : phase;
    case "done":
      return phase;
  }
}

/** What the visitor is doing, as far as the guide cares. */
export interface Doing {
  /** The playback state's kind. */
  sounding: "idle" | "rolling" | "auditioning" | "paused";
  /** Marking a part on the record. */
  marking: boolean;
}

/**
 * The event, if any, that what the visitor is doing means for the guide in `phase`: the first sound
 * starts the narration; taking the needle (or a ring) ends it and counts as the first hint done; marking a
 * part is the second. The page applies this while it renders, so the guide is always in step with what
 * is on the screen.
 */
export function follow(phase: Phase, doing: Doing): Event | null {
  if (phase === "armed") {
    return doing.sounding === "rolling"
      ? "rolled"
      : doing.sounding === "auditioning"
        ? "tookOver"
        : null;
  }
  if (phase === "narrating") return doing.sounding === "auditioning" ? "tookOver" : null;
  if (phase === "hintNeedle") return doing.sounding === "auditioning" ? "needleUsed" : null;
  if (phase === "hintMark") return doing.marking ? "marked" : null;
  return null;
}
