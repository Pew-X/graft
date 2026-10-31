/**
 * How far this browser has got with the make flow's guide, under its own key. One word, written as the
 * guide moves on, so a reload resumes at the right line. It is a courtesy, not a record of anyone: a browser
 * that blocks storage simply shows the guide again, and nothing here can throw.
 *
 * It is separate from the roll's guide (`graft.coach`) on purpose. That reader treats a word it does not know
 * as nothing shown, which starts the whole narrated first visit again for a returning visitor; a new value
 * there would do that to everyone. Here a word this version does not know is read as finished, so a
 * browser that was ahead of this build is never nagged.
 */
import { type MakePhase, PHASES } from "./make.ts";
import { readMade, writeMade } from "./seen.ts";

export const SKETCH_GUIDE_KEY = "graft.coach.sketch";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Where the guide starts for this browser. A fresh visitor starts at the beginning; a browser that finished
 * the older guide (it holds the "made" mark) sees the sketch part once, from "keep"; one with progress of its
 * own resumes there; a word this version does not know is finished.
 */
export function startPhase(store: Store | null = browserStore()): MakePhase {
  let word: string | null = null;
  try {
    word = store?.getItem(SKETCH_GUIDE_KEY) ?? null;
  } catch {
    word = null;
  }
  if (word !== null) {
    return (PHASES as readonly string[]).includes(word) && word !== "pick"
      ? (word as MakePhase)
      : "done";
  }
  return readMade(store) ? "keep" : "pick";
}

/** Write progress. It only goes forward: a replay passing through early lines does not send a browser back. */
export function writeProgress(phase: MakePhase, store: Store | null = browserStore()): void {
  if (phase === "pick") return;
  let had: string | null = null;
  try {
    had = store?.getItem(SKETCH_GUIDE_KEY) ?? null;
  } catch {
    return;
  }
  const hadIndex = had === null ? -1 : (PHASES as readonly string[]).indexOf(had);
  if (hadIndex >= PHASES.indexOf(phase)) return;
  try {
    store?.setItem(SKETCH_GUIDE_KEY, phase);
  } catch {
    /* storage is blocked or full: the guide will show again, which is harmless */
  }
  // the older mark: a browser that has reached the sketch part has been through the first lines
  if (PHASES.indexOf(phase) >= PHASES.indexOf("keep")) writeMade(store);
}
