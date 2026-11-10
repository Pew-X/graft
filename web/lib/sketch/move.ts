/**
 * Moving sketches to another browser or device, with no account and no server: the sketches are written as
 * one line of plain text that can travel as a link (in the address FRAGMENT, which no server ever receives)
 * or as a small file. What travels: each sketch's title, its parent (a published stage's id, or another
 * sketch of the same payload by position), its cut and its speed, and a count and a short checksum, so a link
 * a messenger cut short is noticed. What never travels: manage keys, retry keys, local ids, what a sketch was
 * published as, the bank. An import gives every sketch a fresh local id and a fresh retry key, so two devices
 * can never hold the same retry key.
 *
 * Reading is strict and all or nothing: a version we do not know, a count that does not match, a checksum
 * that fails, a number out of range, a title the text rules refuse, a parent that is not there, a cycle, too
 * deep a path, too many sketches or too long a text refuses the WHOLE payload with a reason in words, and
 * never imports a part.
 */
import { checkSpeed } from "../make/cut.ts";
import { ID_SHAPE } from "../flips/list.ts";
import { type Book, type StorageLike, transact } from "./book.ts";
import { MOST_DEPTH, MOST_SKETCHES, type Parent, type Sketch, newSketchId } from "./sketch.ts";
import { newRetryKey } from "../publish/retry-key.ts";
import { cleanNote, cleanTitle } from "./title.ts";

export const VERSION = "g1";
/** A link's whole fragment may be this long; a file may be larger. */
export const MOST_LINK_BYTES = 8 * 1024;
export const MOST_FILE_BYTES = 64 * 1024;
/** Past this many characters a link is long enough that a file is the better way. */
export const LONG_LINK = 2 * 1024;
export const FRAGMENT = "#sketchbook=";

/** One sketch as it travels. `parent` is a stage id, or the position of another entry. */
export interface Entry {
  title: string;
  parent: string | number;
  start: number;
  end: number;
  p: number;
  q: number;
  /** Optional: a sketch's note travels with it. Older payloads have none. */
  note?: string;
}

export type Refusal =
  | "tooLong"
  | "format"
  | "version"
  | "cutShort"
  | "checksum"
  | "number"
  | "title"
  | "note"
  | "parent"
  | "cycle"
  | "depth"
  | "many";

export type Read = { ok: true; entries: Entry[] } | { ok: false; why: Refusal };

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const b64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function unb64(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The sketches to carry, as entries: parents before the sketches that go on from them. */
export function entriesOf(sketches: readonly Sketch[]): Entry[] {
  const ids = new Set(sketches.map((s) => s.id));
  const ordered: Sketch[] = [];
  const placed = new Set<string>();
  const place = (s: Sketch): void => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    if (s.parent.kind === "sketch" && ids.has(s.parent.id)) {
      const parent = sketches.find((x) => x.id === (s.parent as { id: string }).id);
      if (parent) place(parent);
    }
    ordered.push(s);
  };
  sketches.forEach(place);
  const at = new Map(ordered.map((s, i) => [s.id, i]));
  return ordered.map((s) => ({
    title: s.title,
    parent: s.parent.kind === "stage" ? s.parent.id : (at.get(s.parent.id) ?? -1),
    start: s.cut.start,
    end: s.cut.end,
    p: s.p,
    q: s.q,
    ...(s.note ? { note: s.note } : {}),
  }));
}

/** The one line of text for these entries. */
export function write(entries: readonly Entry[]): string {
  const body = `${VERSION}.${entries.length}.${b64(
    JSON.stringify(
      entries.map((e) =>
        e.note
          ? [e.title, e.parent, e.start, e.end, e.p, e.q, e.note]
          : [e.title, e.parent, e.start, e.end, e.p, e.q],
      ),
    ),
  )}`;
  return `${body}.${fnv1a(body)}`;
}

export const linkFor = (origin: string, entries: readonly Entry[]): string =>
  `${origin}/make${FRAGMENT}${write(entries)}`;

const whole = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Read a payload (the text after `#sketchbook=`, or a file's whole text). Never throws. */
export function read(text: string, mostBytes = MOST_LINK_BYTES): Read {
  const trimmed = text.trim();
  if (trimmed.length > mostBytes) return { ok: false, why: "tooLong" };
  const parts = trimmed.split(".");
  if (parts.length < 2 || parts[0] !== VERSION) {
    return { ok: false, why: /^g\d+$/.test(parts[0] ?? "") ? "version" : "format" };
  }
  if (parts.length !== 4) return { ok: false, why: "cutShort" };
  const [, countText, body, sum] = parts as [string, string, string, string];
  if (!/^\d{1,3}$/.test(countText)) return { ok: false, why: "format" };
  const count = Number(countText);
  if (count > MOST_SKETCHES) return { ok: false, why: "many" };
  if (!/^[0-9a-f]{8}$/.test(sum) || fnv1a(`${VERSION}.${countText}.${body}`) !== sum) {
    // a payload that ends early has no whole checksum; one that was changed has the wrong one
    return { ok: false, why: /^[0-9a-f]{8}$/.test(sum) ? "checksum" : "cutShort" };
  }
  const json = unb64(body);
  if (json === null) return { ok: false, why: "cutShort" };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, why: "cutShort" };
  }
  if (!Array.isArray(data)) return { ok: false, why: "format" };
  if (data.length !== count) return { ok: false, why: "cutShort" };
  const entries: Entry[] = [];
  for (const row of data as unknown[]) {
    if (!Array.isArray(row) || (row.length !== 6 && row.length !== 7))
      return { ok: false, why: "format" };
    const [title, parent, start, end, p, q, note] = row as unknown[];
    if (!whole(start, 10_000_000) || !whole(end, 10_000_000) || end <= start)
      return { ok: false, why: "number" };
    if (typeof p !== "number" || typeof q !== "number" || checkSpeed(p, q) !== null)
      return { ok: false, why: "number" };
    if (typeof title !== "string") return { ok: false, why: "title" };
    const cleaned = cleanTitle(title);
    if (!cleaned.ok || cleaned.value !== title || cleaned.adjusted)
      return { ok: false, why: "title" };
    if (typeof parent === "string") {
      if (!ID_SHAPE.test(parent)) return { ok: false, why: "parent" };
    } else if (!whole(parent, count - 1)) {
      return { ok: false, why: "parent" };
    }
    let kept: string | undefined;
    if (row.length === 7) {
      if (typeof note !== "string") return { ok: false, why: "note" };
      const cleanedNote = cleanNote(note);
      if (!cleanedNote.ok || cleanedNote.value !== note || cleanedNote.adjusted || note === "")
        return { ok: false, why: "note" };
      kept = note;
    }
    entries.push({
      title,
      parent: parent as string | number,
      start,
      end,
      p,
      q,
      ...(kept !== undefined ? { note: kept } : {}),
    });
  }
  // every sketch parent is in the payload, none is its own, there is no cycle, and no path is too deep
  const depthOf = (i: number, seen: readonly number[]): number | "cycle" => {
    const parent = entries[i]?.parent;
    if (typeof parent !== "number") return 1;
    if (seen.includes(parent) || parent === i) return "cycle";
    const above = depthOf(parent, [...seen, i]);
    return above === "cycle" ? "cycle" : above + 1;
  };
  for (let i = 0; i < entries.length; i++) {
    const d = depthOf(i, [i]);
    if (d === "cycle") return { ok: false, why: "cycle" };
    if (d > MOST_DEPTH) return { ok: false, why: "depth" };
  }
  return { ok: true, entries };
}

/** The payload of a link's fragment, or null when the fragment is not a sketchbook link. */
export function fromFragment(hash: string): string | null {
  return hash.startsWith(FRAGMENT) ? hash.slice(FRAGMENT.length) : null;
}

export interface Plan {
  /** The new sketches, parents first, with fresh ids and fresh retry keys. */
  added: Sketch[];
  /** Entries the same as a sketch already here (same parent, cut, speed and title). */
  alreadyHere: number;
  /** Titles of entries that did not fit in the limit of forty (and of those that go on from them). */
  leftOut: string[];
}

/** What importing these entries into this book would do. Pure: nothing is written. */
export function plan(book: Book, entries: readonly Entry[], now = Date.now()): Plan {
  const taken = new Set(book.sketches.map((s) => s.id));
  const local = new Map<number, string | null>(); // payload position -> local id (existing or new); null = left out
  const added: Sketch[] = [];
  const leftOut: string[] = [];
  let alreadyHere = 0;
  const parentOf = (e: Entry): Parent | null => {
    if (typeof e.parent === "string") return { kind: "stage", id: e.parent };
    const id = local.get(e.parent);
    return id === undefined || id === null ? null : { kind: "sketch", id };
  };
  const resolve = (i: number, depth: number): void => {
    if (local.has(i) || depth > MOST_DEPTH + 1) return;
    const e = entries[i];
    if (!e) return;
    if (typeof e.parent === "number") resolve(e.parent, depth + 1);
    const parent = parentOf(e);
    if (parent === null) {
      local.set(i, null);
      leftOut.push(e.title);
      return;
    }
    const twin = [...book.sketches, ...added].find(
      (s) =>
        s.parent.kind === parent.kind &&
        s.parent.id === parent.id &&
        s.cut.start === e.start &&
        s.cut.end === e.end &&
        s.p === e.p &&
        s.q === e.q &&
        s.title === e.title,
    );
    if (twin) {
      local.set(i, twin.id);
      alreadyHere++;
      return;
    }
    if (book.sketches.length + added.length >= MOST_SKETCHES) {
      local.set(i, null);
      leftOut.push(e.title);
      return;
    }
    const id = newSketchId(taken);
    taken.add(id);
    local.set(i, id);
    added.push({
      id,
      parent,
      cut: { start: e.start, end: e.end },
      p: e.p,
      q: e.q,
      title: e.title,
      retryKey: newRetryKey(),
      at: now,
      ...(e.note ? { note: e.note } : {}),
    });
  };
  entries.forEach((_, i) => resolve(i, 0));
  return { added, alreadyHere, leftOut };
}

/** Import entries into this browser's book: planned against the book as it is when the write is made. */
export function importEntries(
  storage: StorageLike | null,
  entries: readonly Entry[],
  now = Date.now(),
): { ok: true; plan: Plan; book: Book } | { ok: false; why: string } {
  const made = transact<Plan>(storage, (book) => {
    const planned = plan(book, entries, now);
    return {
      book: { ...book, sketches: [...book.sketches, ...planned.added] },
      extra: planned,
    };
  });
  return made.ok ? { ok: true, plan: made.extra, book: made.book } : made;
}
