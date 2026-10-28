/**
 * How far this browser has got with the first-visit guide: the narrated first play, then two small hints.
 * The one thing stored is a single word under one key, written as the guide moves on, so a reload does
 * not start it again. It is a courtesy, not a record of anyone. A browser that blocks storage simply
 * shows the guide again, and nothing here can throw.
 *
 * The word is one of: "narrated" (the first play is over, the hints are next), "needle" (the first hint
 * is over), "done" (everything has been shown). "seen" was what the earlier three-card coach wrote; it
 * is read as nothing shown, because the guide it stood for is not the one in use now, and never written.
 */
import type { Phase } from "./first.ts";

export const COACH_KEY = "graft.coach";

/** Every word this key may ever hold. The about page and the storage specs name the same list. */
export const COACH_VALUES = ["narrated", "needle", "done"] as const;

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

/** Where the guide starts for this browser. */
export function readPhase(store: Store | null = browserStore()): Phase {
  try {
    switch (store?.getItem(COACH_KEY)) {
      case "narrated":
        return "hintNeedle";
      case "needle":
        return "hintMark";
      case "done":
        return "done";
      default:
        return "armed";
    }
  } catch {
    return "armed";
  }
}

const RANK: Record<string, number> = { narrated: 1, needle: 2, done: 3 };

/**
 * Write how far the guide has got. Progress only goes forward: replaying the guide from the footer
 * does not send a browser back to the start, so a reload during a replay does not show it all again.
 */
export function writePhase(phase: Phase, store: Store | null = browserStore()): void {
  const word =
    phase === "hintNeedle"
      ? "narrated"
      : phase === "hintMark"
        ? "needle"
        : phase === "done"
          ? "done"
          : null;
  if (word === null) return;
  try {
    const current = store?.getItem(COACH_KEY) ?? "";
    if ((RANK[current] ?? 0) >= RANK[word]!) return;
    store?.setItem(COACH_KEY, word);
  } catch {
    /* storage is blocked or full: the guide will show again, which is harmless */
  }
}
