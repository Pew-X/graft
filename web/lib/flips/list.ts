/**
 * "Your flips": the publications this browser holds a manage key for, as a list. Only what is in the
 * browser's own kept keys goes in (no account, nothing on a server says whose a flip is); what each one
 * is called and whether it is still here is asked of the service, one public read per flip.
 */

/** A publication id: 12 characters from 0-9 and a-z without i, l, o and u. */
export const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{12}$/;

/** The most flips listed at once: a longer list is a quiet page, not a hundred requests. */
export const LISTED_MAX = 20;

/**
 * The ids to list, newest first, from the kept keys (an object in the order they were kept). Anything
 * that is not an id is left out: the kept keys are storage a person (or an old version) may have changed.
 */
export function flipIds(kept: Readonly<Record<string, string>>): string[] {
  return Object.keys(kept)
    .filter((id) => ID_SHAPE.test(id))
    .reverse();
}

/** How a flip stands, from the service's public read of it (`null` when it is not found). */
export type FlipState = "open" | "closed" | "withdrawn" | "missing";

export function stateOf(entry: { state: string; forkPermitted: boolean | null } | null): FlipState {
  if (entry === null) return "missing";
  if (entry.state !== "available") return "withdrawn";
  return entry.forkPermitted === false ? "closed" : "open";
}
