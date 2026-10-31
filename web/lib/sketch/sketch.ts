/**
 * A sketch: a private flip. A parent (a published stage, or another sketch), a cut, a speed, a title,
 * and its own retry key made when it was kept. It is held in this browser only and is never sent
 * anywhere until it is published. A sketch is specs, not audio: the sound is made again when it is
 * needed. It is immutable once kept (a different cut is a new sketch); only its title may change, and
 * the one thing added later is the id of the publication it became.
 *
 * Everything read back from storage, from a link or from a file goes through `parseSketch`: nothing
 * stored is trusted.
 */
import { checkSpeed, type Cut } from "../make/cut.ts";
import { ID_SHAPE } from "../flips/list.ts";

export const TITLE_MAX = 60;
/** Most sketches this browser keeps, and most on one bank. */
export const MOST_SKETCHES = 40;
export const MOST_ON_BANK = 12;
/** A sketch on a path may have at most this many sketches above it (the service refuses a chain of 12 stages). */
export const MOST_DEPTH = 12;

/** A sketch's local id: "sk" and twelve characters. Never the shape of a publication id (twelve). */
export const SKETCH_ID = /^sk[0-9a-hjkmnp-tv-z]{12}$/;
const RETRY_KEY = /^[A-Za-z0-9_-]{16,80}$/;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type Parent = { kind: "stage"; id: string } | { kind: "sketch"; id: string };

export interface Sketch {
  id: string;
  parent: Parent;
  cut: Cut;
  p: number;
  q: number;
  title: string;
  /** Made when the sketch was kept and bound to its content: a publish of this sketch always sends this key. */
  retryKey: string;
  /** When it was kept, milliseconds since the epoch. */
  at: number;
  /** The id of the publication this sketch became; set once, and a published sketch is never published again. */
  publishedAs?: string;
}

/** A fresh local id that is not in `taken`: a collision is re-rolled. */
export function newSketchId(taken: ReadonlySet<string>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const id = `sk${[...bytes].map((b) => ALPHABET[b % 32]).join("")}`;
    if (!taken.has(id)) return id;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** A stored title: plain text of at most 60 characters with no control or line-break characters. */
export function plainTitle(v: unknown): v is string {
  return typeof v === "string" && [...v].length <= TITLE_MAX && !/[\p{C}\u2028\u2029]/u.test(v);
}

export function parseParent(v: unknown): Parent | null {
  if (!isRecord(v) || typeof v["id"] !== "string") return null;
  if (v["kind"] === "stage" && ID_SHAPE.test(v["id"])) return { kind: "stage", id: v["id"] };
  if (v["kind"] === "sketch" && SKETCH_ID.test(v["id"])) return { kind: "sketch", id: v["id"] };
  return null;
}

/** One sketch from untrusted data, or null. Strict: any field of the wrong shape or range refuses the whole sketch. */
export function parseSketch(v: unknown): Sketch | null {
  if (!isRecord(v)) return null;
  const id = v["id"];
  if (typeof id !== "string" || !SKETCH_ID.test(id)) return null;
  const parent = parseParent(v["parent"]);
  if (parent === null || parent.id === id) return null;
  const cut = v["cut"];
  if (!isRecord(cut) || !whole(cut["start"], 10_000_000) || !whole(cut["end"], 10_000_000))
    return null;
  if (cut["end"] <= cut["start"]) return null;
  const p = v["p"];
  const q = v["q"];
  if (typeof p !== "number" || typeof q !== "number" || checkSpeed(p, q) !== null) return null;
  if (!plainTitle(v["title"])) return null;
  const retryKey = v["retryKey"];
  if (typeof retryKey !== "string" || !RETRY_KEY.test(retryKey)) return null;
  const at = v["at"];
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return null;
  const published = v["publishedAs"];
  if (published !== undefined && (typeof published !== "string" || !ID_SHAPE.test(published)))
    return null;
  return {
    id,
    parent,
    cut: { start: cut["start"], end: cut["end"] },
    p,
    q,
    title: v["title"],
    retryKey,
    at,
    ...(typeof published === "string" ? { publishedAs: published } : {}),
  };
}

/** The same try: same parent, cut and speed (the title does not make a different one). */
export function sameTry(
  a: Sketch | Pick<Sketch, "parent" | "cut" | "p" | "q">,
  b: typeof a,
): boolean {
  return (
    a.parent.kind === b.parent.kind &&
    a.parent.id === b.parent.id &&
    a.cut.start === b.cut.start &&
    a.cut.end === b.cut.end &&
    a.p === b.p &&
    a.q === b.q
  );
}
