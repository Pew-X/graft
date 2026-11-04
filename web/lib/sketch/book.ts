/**
 * The sketch book: every sketch this browser keeps, in persistent `localStorage` (so it survives closing
 * the tab and the browser; a private window loses it on close). Plain functions over a storage object, so
 * every path is testable without a browser. Every write reads the store afresh first, so two tabs never
 * overwrite each other; storage that is missing, full or throws is a refusal with a reason, never an error
 * page and never a half-written store; data from a newer version of graft is left exactly as it is.
 */
import {
  MOST_ON_BANK,
  MOST_SKETCHES,
  type Parent,
  type Sketch,
  newSketchId,
  parseSketch,
} from "./sketch.ts";
import { newRetryKey } from "../publish/retry-key.ts";

export const BOOK_KEY = "graft.sketches";
export const FORMAT = 1;
/** A store larger than this is not ours (40 sketches are a few kilobytes): it is ignored whole. */
const MOST_BYTES = 256 * 1024;
/** Entries that are not valid sketches are kept as they are (up to this many) and never shown. */
const MOST_UNREAD = 40;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Book {
  sketches: Sketch[];
  /** The sketch bank: sketch ids in pad order, each at most once, at most twelve. */
  bank: string[];
  /** The store was written by a newer version: shown if it can be, never written. */
  newer: boolean;
  /** Entries that could not be read, kept as they were. */
  unread: unknown[];
}

export const EMPTY: Book = { sketches: [], bank: [], newer: false, unread: [] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the raw text of the store says. Never throws. */
export function parseBook(text: string | null): Book {
  if (text === null || text.length > MOST_BYTES) return EMPTY;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (!isRecord(data)) return EMPTY;
  if (typeof data["v"] === "number" && data["v"] > FORMAT) return { ...EMPTY, newer: true };
  if (data["v"] !== FORMAT) return EMPTY;
  const entries = Array.isArray(data["sketches"]) ? (data["sketches"] as unknown[]) : [];
  const sketches: Sketch[] = [];
  const unread: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, MOST_SKETCHES + MOST_UNREAD)) {
    const sketch = parseSketch(entry);
    // a parent sketch that is not in the book leaves its child unreadable: no sketch has a missing parent
    if (sketch === null || seen.has(sketch.id)) {
      if (unread.length < MOST_UNREAD) unread.push(entry);
      continue;
    }
    seen.add(sketch.id);
    sketches.push(sketch);
  }
  // a sketch whose parent sketch is not in the book is unreadable too, and so is whatever goes on from it:
  // repeat until no more sketches are lost, so no sketch left has a missing parent at any depth
  let kept = sketches;
  for (;;) {
    const ids = new Set(kept.map((s) => s.id));
    const next = kept.filter((s) => s.parent.kind === "stage" || ids.has(s.parent.id));
    if (next.length === kept.length) break;
    kept = next;
  }
  const keptIds = new Set(kept.map((s) => s.id));
  const orphans = sketches.filter((s) => !keptIds.has(s.id));
  const bankRaw = Array.isArray(data["bank"]) ? (data["bank"] as unknown[]) : [];
  const bank: string[] = [];
  for (const id of bankRaw) {
    if (
      typeof id === "string" &&
      keptIds.has(id) &&
      !bank.includes(id) &&
      bank.length < MOST_ON_BANK
    )
      bank.push(id);
  }
  return {
    sketches: kept.slice(0, MOST_SKETCHES),
    bank,
    newer: false,
    unread: [...unread, ...orphans].slice(0, MOST_UNREAD),
  };
}

export function readBook(storage: StorageLike | null): Book {
  try {
    return parseBook(storage?.getItem(BOOK_KEY) ?? null);
  } catch {
    return EMPTY; // storage that throws on access holds nothing for us
  }
}

export function serialize(book: Book): string {
  return JSON.stringify({
    v: FORMAT,
    sketches: [...book.sketches, ...book.unread],
    bank: book.bank,
  });
}

export type WriteWhy = "storage" | "newer";

/** Write the book. The stored text is read back, so a store that took the write but holds something else is not believed. */
function write(storage: StorageLike | null, book: Book): WriteWhy | null {
  if (storage === null) return "storage";
  try {
    const text = serialize(book);
    storage.setItem(BOOK_KEY, text);
    return storage.getItem(BOOK_KEY) === text ? null : "storage";
  } catch {
    return "storage"; // full, or blocked
  }
}

/** A change to the freshly read book: the edit returns the new book (with anything else to report), or a reason it is refused. */
export function transact<T>(
  storage: StorageLike | null,
  edit: (book: Book) => { book: Book; extra: T } | string,
): { ok: true; book: Book; extra: T } | { ok: false; why: string } {
  const book = readBook(storage);
  if (book.newer) return { ok: false, why: "newer" };
  const made = edit(book);
  if (typeof made === "string") return { ok: false, why: made };
  const failed = write(storage, made.book);
  if (failed !== null) return { ok: false, why: failed };
  return { ok: true, ...made };
}

export interface KeepInput {
  parent: Parent;
  cut: { start: number; end: number };
  p: number;
  q: number;
  title: string;
  /** Optional, already cleaned. */
  note?: string;
}

export type Kept =
  | { ok: true; book: Book; sketch: Sketch }
  | { ok: false; why: "storage" | "newer" | "limit" | "invalid" };

/**
 * Keep a try as a new sketch with a fresh id and its own retry key. At the limit nothing is dropped:
 * the answer is "limit", and `oldestUnused` names the oldest sketch nothing else goes on from, which
 * the page can offer for discard.
 */
export function keep(storage: StorageLike | null, input: KeepInput, now = Date.now()): Kept {
  const made = transact<Sketch>(storage, (book) => {
    if (book.sketches.length >= MOST_SKETCHES) return "limit";
    if (input.parent.kind === "sketch" && !book.sketches.some((s) => s.id === input.parent.id))
      return "invalid";
    const candidate: Sketch = {
      id: newSketchId(new Set(book.sketches.map((s) => s.id))),
      parent: input.parent,
      cut: { ...input.cut },
      p: input.p,
      q: input.q,
      title: input.title,
      retryKey: newRetryKey(),
      at: now,
      ...(input.note ? { note: input.note } : {}),
    };
    if (parseSketch(candidate) === null) return "invalid";
    return { book: { ...book, sketches: [...book.sketches, candidate] }, extra: candidate };
  });
  return made.ok
    ? { ok: true, book: made.book, sketch: made.extra }
    : { ok: false, why: made.why as "storage" | "newer" | "limit" | "invalid" };
}

/** The sketches that go on from `id`, directly or further (every sketch below it). */
export function below(book: Book, id: string): Sketch[] {
  const out: Sketch[] = [];
  const frontier = [id];
  while (frontier.length > 0) {
    const at = frontier.pop();
    for (const s of book.sketches) {
      if (s.parent.kind === "sketch" && s.parent.id === at && !out.includes(s)) {
        out.push(s);
        frontier.push(s.id);
      }
    }
  }
  return out;
}

/** The oldest sketch that no other sketch goes on from, to offer for discard when the book is full. */
export function oldestUnused(book: Book): Sketch | null {
  const used = new Set(
    book.sketches.flatMap((s) => (s.parent.kind === "sketch" ? [s.parent.id] : [])),
  );
  return [...book.sketches].sort((a, b) => a.at - b.at).find((s) => !used.has(s.id)) ?? null;
}

/**
 * Discard a sketch, and with it every sketch that goes on from it (one rule: no sketch is ever left with
 * a missing parent). They also leave the bank. Returns the ids removed.
 */
export function discard(
  storage: StorageLike | null,
  id: string,
): { ok: true; book: Book; removed: string[] } | { ok: false; why: string } {
  const made = transact<string[]>(storage, (book) => {
    if (!book.sketches.some((s) => s.id === id)) return { book, extra: [] };
    const removed = new Set([id, ...below(book, id).map((s) => s.id)]);
    return {
      book: {
        ...book,
        sketches: book.sketches.filter((s) => !removed.has(s.id)),
        bank: book.bank.filter((b) => !removed.has(b)),
      },
      extra: [...removed],
    };
  });
  return made.ok ? { ok: true, book: made.book, removed: made.extra } : made;
}

export function rename(
  storage: StorageLike | null,
  id: string,
  title: string,
): { ok: true; book: Book } | { ok: false; why: string } {
  const made = transact<null>(storage, (book) => {
    const target = book.sketches.find((s) => s.id === id);
    if (!target) return "missing";
    if (target.publishedAs !== undefined) return "published";
    const next = { ...target, title };
    if (parseSketch(next) === null) return "invalid";
    return {
      book: { ...book, sketches: book.sketches.map((s) => (s.id === id ? next : s)) },
      extra: null,
    };
  });
  return made.ok ? { ok: true, book: made.book } : made;
}

/** Set, change or clear (with "") the note of a sketch. A note can be edited before and after publishing: it is the maker's own. */
export function setNote(
  storage: StorageLike | null,
  id: string,
  note: string,
): { ok: true; book: Book } | { ok: false; why: string } {
  const made = transact<null>(storage, (book) => {
    const target = book.sketches.find((s) => s.id === id);
    if (!target) return "missing";
    const next: Sketch = { ...target };
    if (note === "") delete next.note;
    else next.note = note;
    if (parseSketch(next) === null) return "invalid";
    return {
      book: { ...book, sketches: book.sketches.map((s) => (s.id === id ? next : s)) },
      extra: null,
    };
  });
  return made.ok ? { ok: true, book: made.book } : made;
}

/** Record that a sketch became this publication. Once set it is never changed. */
export function markPublished(
  storage: StorageLike | null,
  id: string,
  publication: string,
): { ok: true; book: Book } | { ok: false; why: string } {
  const made = transact<null>(storage, (book) => {
    const target = book.sketches.find((s) => s.id === id);
    if (!target) return "missing";
    if (target.publishedAs !== undefined) return { book, extra: null };
    const next = { ...target, publishedAs: publication };
    if (parseSketch(next) === null) return "invalid";
    return {
      book: { ...book, sketches: book.sketches.map((s) => (s.id === id ? next : s)) },
      extra: null,
    };
  });
  return made.ok ? { ok: true, book: made.book } : made;
}

/** Another sketch of the same parent, cut and speed, so a set does not publish two identical flips by accident. */
export function twinOf(book: Book, sketch: Sketch): Sketch | null {
  return (
    book.sketches.find(
      (s) =>
        s.id !== sketch.id &&
        s.at <= sketch.at &&
        s.parent.kind === sketch.parent.kind &&
        s.parent.id === sketch.parent.id &&
        s.cut.start === sketch.cut.start &&
        s.cut.end === sketch.cut.end &&
        s.p === sketch.p &&
        s.q === sketch.q,
    ) ?? null
  );
}

export type BankChange = { ok: true; book: Book } | { ok: false; why: "full" | "missing" | string };

/** Put a sketch on the sketch bank, last. A sketch is on a bank at most once, and a bank holds twelve. */
export function addToBank(storage: StorageLike | null, id: string): BankChange {
  const made = transact<null>(storage, (book) => {
    if (!book.sketches.some((s) => s.id === id)) return "missing";
    if (book.bank.includes(id)) return { book, extra: null };
    if (book.bank.length >= MOST_ON_BANK) return "full";
    return { book: { ...book, bank: [...book.bank, id] }, extra: null };
  });
  return made.ok ? { ok: true, book: made.book } : made;
}

export function removeFromBank(storage: StorageLike | null, id: string): BankChange {
  const made = transact<null>(storage, (book) => ({
    book: { ...book, bank: book.bank.filter((b) => b !== id) },
    extra: null,
  }));
  return made.ok ? { ok: true, book: made.book } : made;
}

/** Move a pad earlier (negative) or later (positive) by a number of places, stopping at the ends. */
export function moveInBank(storage: StorageLike | null, id: string, by: number): BankChange {
  const made = transact<null>(storage, (book) => {
    const at = book.bank.indexOf(id);
    if (at < 0) return "missing";
    const to = Math.max(0, Math.min(book.bank.length - 1, at + by));
    const bank = [...book.bank];
    bank.splice(at, 1);
    bank.splice(to, 0, id);
    return { book: { ...book, bank }, extra: null };
  });
  return made.ok ? { ok: true, book: made.book } : made;
}
