import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type StorageLike, parseBook, readBook } from "./book.ts";
import {
  type Entry,
  FRAGMENT,
  LONG_LINK,
  MOST_FILE_BYTES,
  entriesOf,
  fromFragment,
  importEntries,
  linkFor,
  plan,
  read,
  write,
} from "./move.ts";
import { MOST_SKETCHES, type Sketch } from "./sketch.ts";

const STAGE = "es1418qka9yt";
const entry = (over: Partial<Entry> = {}): Entry => ({
  title: "up a fifth",
  parent: STAGE,
  start: 0,
  end: 24_000,
  p: 3,
  q: 2,
  ...over,
});

class Fake implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const sketch = (n: number, over: Partial<Sketch> = {}): Sketch => ({
  id: `sk${String(n).padStart(12, "0")}`,
  parent: { kind: "stage", id: STAGE },
  cut: { start: 0, end: 1000 + n },
  p: 3,
  q: 2,
  title: `try ${n}`,
  retryKey: `web-0123456789abcdef0123456789ab${String(n).padStart(2, "0")}`,
  at: n,
  ...over,
});

test("what is written is read back exactly, in a form that is a link-safe line of text", () => {
  const entries = [entry(), entry({ title: "second", parent: 0, start: 5, end: 9000, p: 1, q: 2 })];
  const text = write(entries);
  assert.match(text, /^g1\.2\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
  assert.deepEqual(read(text), { ok: true, entries });
  assert.equal(fromFragment(`${FRAGMENT}${text}`), text);
  assert.equal(fromFragment("#phrase=1:2"), null);
});

test("nothing that could publish or identify travels: no key, no local id, no published link", () => {
  const sketches = [sketch(1, { publishedAs: "aaaaaaaaaaaa" }), sketch(2)];
  const text = write(entriesOf(sketches));
  const decoded = atob(text.split(".")[2]!.replace(/-/g, "+").replace(/_/g, "/"));
  for (const secret of ["retryKey", "web-0123", "sk0000", "publishedAs", "aaaaaaaaaaaa", "bank"])
    assert.equal(decoded.includes(secret), false, secret);
});

test("a sketch that goes on from another travels after it, and its parent is a position", () => {
  const root = sketch(1);
  const child = sketch(2, { parent: { kind: "sketch", id: root.id } });
  const entries = entriesOf([child, root]);
  assert.equal(entries[0]?.title, root.title);
  assert.equal(entries[1]?.parent, 0);
});

test("forty sketches stay well under the size of a link", () => {
  const forty = Array.from({ length: MOST_SKETCHES }, (_, n) =>
    sketch(n, { title: "x".repeat(60) }),
  );
  const text = write(entriesOf(forty));
  assert.ok(text.length < 8 * 1024, String(text.length));
  assert.equal(read(text).ok, true);
  assert.ok(LONG_LINK < text.length, "a full book is long enough to suggest a file");
});

test("a link cut short at any length is refused whole, never partly read", () => {
  const text = write([entry(), entry({ title: "b", start: 1 }), entry({ title: "c", start: 2 })]);
  for (let length = 0; length < text.length; length++) {
    const r = read(text.slice(0, length));
    assert.equal(r.ok, false, `length ${length}`);
  }
  assert.deepEqual(read(text.slice(0, text.length - 3)), { ok: false, why: "cutShort" });
});

test("every single changed character is refused: a damaged link is never imported", () => {
  const text = write([entry(), entry({ title: "b", start: 1 })]);
  const alphabet = "abcXYZ019_-.";
  for (let i = 0; i < text.length; i++) {
    for (const c of alphabet) {
      if (text[i] === c) continue;
      const changed = text.slice(0, i) + c + text.slice(i + 1);
      assert.equal(read(changed).ok, false, `${i}:${c}`);
    }
  }
});

test("anything at all is read without throwing, and only exactly what write made is accepted", () => {
  fc.assert(
    fc.property(fc.string(), (text) => assert.doesNotThrow(() => read(text))),
    {
      numRuns: 500,
    },
  );
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
      const text = String.fromCharCode(...bytes);
      assert.equal(read(text).ok, false);
    }),
    { numRuns: 300 },
  );
});

test("a version we do not know, a wrong shape and a text that is far too long each say so", () => {
  assert.deepEqual(read("g2.1.abc.00000000"), { ok: false, why: "version" });
  assert.deepEqual(read("hello"), { ok: false, why: "format" });
  assert.deepEqual(read("x".repeat(9000)), { ok: false, why: "tooLong" });
  assert.deepEqual(read("x".repeat(70_000), MOST_FILE_BYTES), { ok: false, why: "tooLong" });
  assert.deepEqual(read("g1.41.abc.00000000"), { ok: false, why: "many" });
});

test("numbers out of range are refused: a cut, a speed, a position", () => {
  for (const bad of [
    entry({ start: -1 }),
    entry({ end: 0 }),
    entry({ start: 9, end: 9 }),
    entry({ end: 10_000_001 }),
    entry({ p: 0 }),
    entry({ q: 0 }),
    entry({ p: 99, q: 1 }),
    entry({ p: 1.5 }),
    entry({ start: 0.5 }),
    entry({ parent: 1 }),
    entry({ parent: -1 }),
    entry({ parent: "../../etc" }),
  ])
    assert.deepEqual(read(write([bad])).ok, false, JSON.stringify(bad));
});

test("a title that the text rules would change or refuse is refused", () => {
  for (const title of [
    "",
    " padded ",
    "see example.com",
    "@someone",
    "a‮b",
    "x".repeat(61),
    "pаypal",
  ])
    assert.deepEqual(
      read(write([entry({ title })])),
      { ok: false, why: "title" },
      JSON.stringify(title),
    );
});

test("a sketch that is its own parent, a cycle, and a path over twelve deep are each refused", () => {
  assert.deepEqual(read(write([entry({ parent: 0 })])), { ok: false, why: "cycle" });
  assert.deepEqual(read(write([entry({ parent: 1 }), entry({ parent: 0 })])), {
    ok: false,
    why: "cycle",
  });
  const deep = (n: number): Entry[] =>
    Array.from({ length: n }, (_, i) => entry({ parent: i === 0 ? STAGE : i - 1, end: 1000 + i }));
  assert.equal(read(write(deep(12))).ok, true);
  assert.deepEqual(read(write(deep(13))), { ok: false, why: "depth" });
});

test("importing gives every sketch a fresh id and a fresh retry key, and keeps the parents", () => {
  const s = new Fake();
  const entries = [entry(), entry({ title: "child", parent: 0, end: 2000 })];
  const done = importEntries(s, entries);
  assert.ok(done.ok);
  const book = readBook(s);
  assert.equal(book.sketches.length, 2);
  const [a, b] = book.sketches;
  assert.notEqual(a?.retryKey, b?.retryKey);
  assert.equal(b?.parent.kind, "sketch");
  assert.equal(b?.parent.id, a?.id);
  // the same import on a second browser shares nothing
  const t = new Fake();
  importEntries(t, entries);
  const other = readBook(t).sketches;
  for (const x of other)
    assert.equal(
      book.sketches.some((y) => y.id === x.id || y.retryKey === x.retryKey),
      false,
    );
});

test("what is already here is skipped and counted, and nothing is overwritten", () => {
  const s = new Fake();
  importEntries(s, [entry()]);
  const before = readBook(s).sketches[0]!;
  const again = importEntries(s, [entry(), entry({ title: "new", end: 5000 })]);
  assert.ok(again.ok);
  assert.equal(again.plan.alreadyHere, 1);
  assert.equal(again.plan.added.length, 1);
  const book = readBook(s);
  assert.equal(book.sketches.length, 2);
  assert.deepEqual(book.sketches[0], before);
});

test("past the limit only what fits is added and the rest is named, with whatever goes on from it", () => {
  const book = parseBook(
    JSON.stringify({
      v: 1,
      sketches: Array.from({ length: 38 }, (_, n) => sketch(n)),
      bank: [],
    }),
  );
  assert.equal(book.sketches.length, 38);
  const entries = [
    entry({ title: "fits", end: 90_001 }),
    entry({ title: "also fits", end: 90_002 }),
    entry({ title: "left out", end: 90_003 }),
    entry({ title: "child of left out", end: 90_004, parent: 2 }),
  ];
  const planned = plan(book, entries);
  assert.deepEqual(
    planned.added.map((x) => x.title),
    ["fits", "also fits"],
  );
  assert.deepEqual(planned.leftOut, ["left out", "child of left out"]);
});

test("a store from a newer version refuses an import and is left alone", () => {
  const s = new Fake();
  s.data.set("graft.sketches", JSON.stringify({ v: 2 }));
  assert.deepEqual(importEntries(s, [entry()]), { ok: false, why: "newer" });
  assert.equal(s.data.get("graft.sketches"), JSON.stringify({ v: 2 }));
});

test("a link is the fragment form of the same text", () => {
  const link = linkFor("https://graft.example", [entry()]);
  const url = new URL(link);
  assert.equal(url.pathname, "/make");
  assert.equal(url.search, "", "never the query string");
  assert.equal(read(fromFragment(url.hash)!).ok, true);
});

test("a note travels with its sketch, and an entry without one stays six fields", () => {
  const withNote = entry({ note: "from the tape at the lake" });
  const plain = entry({ title: "plain" });
  const back = read(write([withNote, plain]));
  assert.ok(back.ok);
  assert.equal(back.entries[0]?.note, "from the tape at the lake");
  assert.equal("note" in (back.entries[1] ?? {}), false);
});

test("a note that breaks the rules refuses the whole payload", () => {
  for (const note of ["see example.com", "x".repeat(141), "two\nlines"]) {
    const r = read(write([entry({ note })]));
    assert.deepEqual(r, { ok: false, why: "note" }, JSON.stringify(note));
  }
});

test("an imported note becomes the sketch's note", () => {
  const s = new Fake();
  const done = importEntries(s, [entry({ note: "lake" })], 5);
  assert.ok(done.ok);
  assert.equal(readBook(s).sketches[0]?.note, "lake");
});
