/**
 * What a set publish keeps in this browser between tabs and visits: which sketches were chosen (and the name
 * to publish them under), and a small timestamped lease so two tabs never publish the same set at once. A
 * lease that is not refreshed (a closed tab) is free again after a minute. Both are plain text in
 * `localStorage`, read defensively; neither holds a key or any secret.
 */
import { SKETCH_ID } from "./sketch.ts";
import type { StorageLike } from "./book.ts";

export const SET_KEY = "graft.sketch-set";
export const LEASE_KEY = "graft.sketch-lease";
/** A lease older than this is a closed tab's, and may be taken over. */
export const LEASE_MS = 60_000;

export interface Chosen {
  ids: string[];
  author: string;
}

export function readChosen(storage: StorageLike | null): Chosen {
  try {
    const data: unknown = JSON.parse(storage?.getItem(SET_KEY) ?? "null");
    if (typeof data !== "object" || data === null) return { ids: [], author: "" };
    const o = data as Record<string, unknown>;
    const ids = Array.isArray(o["ids"])
      ? (o["ids"] as unknown[])
          .filter((x): x is string => typeof x === "string" && SKETCH_ID.test(x))
          .slice(0, 40)
      : [];
    const author = typeof o["author"] === "string" ? o["author"].slice(0, 64) : "";
    return { ids: [...new Set(ids)], author };
  } catch {
    return { ids: [], author: "" };
  }
}

export function writeChosen(storage: StorageLike | null, chosen: Chosen): boolean {
  if (storage === null) return false;
  try {
    if (chosen.ids.length === 0 && chosen.author === "") storage.removeItem(SET_KEY);
    else storage.setItem(SET_KEY, JSON.stringify(chosen));
    return true;
  } catch {
    return false;
  }
}

interface Lease {
  tab: string;
  at: number;
}

function readLease(storage: StorageLike | null): Lease | null {
  try {
    const data: unknown = JSON.parse(storage?.getItem(LEASE_KEY) ?? "null");
    if (typeof data !== "object" || data === null) return null;
    const o = data as Record<string, unknown>;
    return typeof o["tab"] === "string" && typeof o["at"] === "number"
      ? { tab: o["tab"], at: o["at"] }
      : null;
  } catch {
    return null;
  }
}

/** Claim the lease for this tab: it is free, or this tab's own, or a stale one. */
export function takeLease(
  storage: StorageLike | null,
  tab: string,
  now: number,
): { ok: true } | { ok: false } {
  if (storage === null) return { ok: true }; // nothing shared, so nothing to clash with
  const held = readLease(storage);
  if (held !== null && held.tab !== tab && now - held.at < LEASE_MS) return { ok: false };
  try {
    storage.setItem(LEASE_KEY, JSON.stringify({ tab, at: now } satisfies Lease));
  } catch {
    /* a store that will not hold it leaves no clash to avoid */
  }
  return { ok: true };
}

export function refreshLease(storage: StorageLike | null, tab: string, now: number): void {
  const held = readLease(storage);
  if (held === null || held.tab === tab) takeLease(storage, tab, now);
}

export function releaseLease(storage: StorageLike | null, tab: string): void {
  try {
    if (readLease(storage)?.tab === tab) storage?.removeItem(LEASE_KEY);
  } catch {
    /* nothing to release */
  }
}

/** Whether another tab holds a live lease. */
export function leasedElsewhere(storage: StorageLike | null, tab: string, now: number): boolean {
  const held = readLease(storage);
  return held !== null && held.tab !== tab && now - held.at < LEASE_MS;
}
