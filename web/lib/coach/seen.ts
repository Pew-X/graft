/**
 * Whether this browser has already been shown the first-visit coach. The one thing it stores is the
 * word "seen" under one key, and only when the visitor finishes or skips the coach: it is a courtesy,
 * not a record of anyone. A browser that blocks storage simply shows the coach again, and nothing
 * here can throw.
 */
export const COACH_KEY = "graft.coach";

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

export function coachSeen(store: Store | null = browserStore()): boolean {
  try {
    return store?.getItem(COACH_KEY) === "seen";
  } catch {
    return false;
  }
}

export function markCoachSeen(store: Store | null = browserStore()): void {
  try {
    store?.setItem(COACH_KEY, "seen");
  } catch {
    /* storage is blocked or full: the coach will show again, which is harmless */
  }
}
