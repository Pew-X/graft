/**
 * How far this browser has got with the first-visit guide: the narrated first play, two small hints on the
 * roll, and the make flow's short run of hints. The one thing stored is a single word under one key,
 * written as the guide moves on, so a reload does not start it again. It is a courtesy, not a record of
 * anyone. A browser that blocks storage simply shows the guide again, and nothing here can throw.
 *
 * The word names how far the roll's guide has got: "narrated" (the first play is over, the hints are
 * next), "needle" (the first hint is over), "done" (the second hint is over: this was the last word before
 * the perform hint existed, so a browser holding it sees that hint once), "keys" (everything on the roll
 * has been shown). When the make
 * flow's hints have been shown too, "+made" is added to it ("keys+made"); "made" alone is a browser that
 * has been through the make flow first. "seen" was what the earlier three-card coach wrote; it is read as
 * nothing shown, because the guide it stood for is not the one in use now, and never written.
 */
import type { Phase } from "./first.ts";

export const COACH_KEY = "graft.coach";

/** Every word this key may ever hold. The about page and the storage specs name the same list. */
export const COACH_VALUES = [
  "narrated",
  "needle",
  "done",
  "keys",
  "made",
  "narrated+made",
  "needle+made",
  "done+made",
  "keys+made",
] as const;

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

const RANK: Record<string, number> = { narrated: 1, needle: 2, done: 3, keys: 4 };
const ROLL = ["", "narrated", "needle", "done", "keys"] as const;

/** What a stored word says: how far the roll's guide got (0 to 4) and whether the make flow's was shown. */
function parse(word: string | null | undefined): { roll: number; made: boolean } {
  const [first = "", second = ""] = (word ?? "").split("+");
  const made = first === "made" || second === "made";
  return { roll: made && first === "made" ? 0 : (RANK[first] ?? 0), made };
}

function word(roll: number, made: boolean): string | null {
  const base = ROLL[roll] ?? "";
  return base === "" ? (made ? "made" : null) : made ? `${base}+made` : base;
}

function read(store: Store | null): { roll: number; made: boolean } {
  try {
    return parse(store?.getItem(COACH_KEY));
  } catch {
    return { roll: 0, made: false };
  }
}

function write(store: Store | null, roll: number, made: boolean): void {
  const next = word(roll, made);
  if (next === null) return;
  try {
    store?.setItem(COACH_KEY, next);
  } catch {
    /* storage is blocked or full: the guide will show again, which is harmless */
  }
}

/** Where the roll's guide starts for this browser. */
export function readPhase(store: Store | null = browserStore()): Phase {
  switch (read(store).roll) {
    case 1:
      return "hintNeedle";
    case 2:
      return "hintMark";
    case 3:
      return "hintPerform";
    case 4:
      return "done";
    default:
      return "armed";
  }
}

/**
 * Write how far the roll's guide has got. Progress only goes forward: replaying the guide does not send
 * a browser back to the start, so a reload during a replay does not show it all again. The make flow's
 * mark is kept as it is.
 */
export function writePhase(phase: Phase, store: Store | null = browserStore()): void {
  const reached =
    phase === "hintNeedle"
      ? 1
      : phase === "hintMark"
        ? 2
        : phase === "hintPerform"
          ? 3
          : phase === "done"
            ? 4
            : 0;
  if (reached === 0) return;
  const now = read(store);
  if (now.roll >= reached) return;
  write(store, reached, now.made);
}

/** Whether the make flow's hints have already been shown to this browser. */
export function readMade(store: Store | null = browserStore()): boolean {
  return read(store).made;
}

/** Note that the make flow's hints have been shown. The roll's progress is kept as it is. */
export function writeMade(store: Store | null = browserStore()): void {
  const now = read(store);
  if (now.made) return;
  write(store, now.roll, true);
}
