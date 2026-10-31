import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOK_KEY,
  type KeepInput,
  type StorageLike,
  below,
  discard,
  keep,
  markPublished,
  oldestUnused,
  parseBook,
  readBook,
  rename,
  twinOf,
} from "./book.ts";
import { MOST_SKETCHES, SKETCH_ID, newSketchId } from "./sketch.ts";

class Fake implements StorageLike {
  data = new Map<string, string>();
  fail: "none" | "set" | "get" | "silent" = "none";
  getItem(key: string): string | null {
    if (this.fail === "get") throw new Error("blocked");
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.fail === "set") throw new DOMException("full", "QuotaExceededError");
    if (this.fail === "silent") return; // took the write and kept nothing
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const STAGE = "es1418qka9yt";
const input = (over: Partial<KeepInput> = {}): KeepInput => ({
  parent: { kind: "stage", id: STAGE },
  cut: { start: 0, end: 24_000 },
  p: 3,
  q: 2,
  title: "up a fifth",
  ...over,
});

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

test("a kept sketch is listed, is its own copy with its own key and id, and is still there after a reload", () => {
  const s = new Fake();
  const a = must(keep(s, input())).sketch;
  const b = must(keep(s, input({ cut: { start: 0, end: 12_000 } }))).sketch;
  assert.match(a.id, SKETCH_ID);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.retryKey, b.retryKey, "no two sketches ever share a retry key");
  const reloaded = readBook(s);
  assert.deepEqual(
    reloaded.sketches.map((x) => x.id),
    [a.id, b.id],
  );
  assert.deepEqual(reloaded.sketches[0], a);
});

test("storage that throws on write or read, or takes a write and keeps nothing, refuses the keep and writes nothing half", () => {
  for (const fail of ["set", "silent"] as const) {
    const s = new Fake();
    s.fail = fail;
    const r = keep(s, input());
    assert.deepEqual(r, { ok: false, why: "storage" }, fail);
    assert.equal(s.data.has(BOOK_KEY), false);
  }
  const blocked = new Fake();
  blocked.fail = "get";
  assert.deepEqual(readBook(blocked).sketches, []);
  assert.deepEqual(keep(null, input()), { ok: false, why: "storage" });
});

test("a full store keeps what was there: the failed keep changes nothing", () => {
  const s = new Fake();
  must(keep(s, input()));
  const before = s.data.get(BOOK_KEY);
  s.fail = "set";
  assert.equal(keep(s, input({ cut: { start: 1, end: 9_000 } })).ok, false);
  assert.equal(s.data.get(BOOK_KEY), before);
});

test("corrupt, wrong-shape and hostile entries are skipped one by one and never stop the rest", () => {
  const s = new Fake();
  const good = must(keep(s, input())).sketch;
  const stored = JSON.parse(s.data.get(BOOK_KEY) ?? "{}") as { sketches: unknown[] };
  stored.sketches.push(
    null,
    "text",
    { id: "nope" },
    { ...good, id: "sk" + "0".repeat(12), cut: { start: 5, end: 5 } },
    { ...good, id: "sk" + "1".repeat(12), p: 99, q: 1 },
    { ...good, id: "sk" + "2".repeat(12), title: "x".repeat(61) },
    { ...good, id: "sk" + "3".repeat(12), title: "a‮b" },
    { ...good, id: "sk" + "4".repeat(12), retryKey: "short" },
    { ...good, id: "sk" + "5".repeat(12), parent: { kind: "stage", id: "../../x" } },
    { ...good, id: "sk" + "6".repeat(12), cut: { start: -1, end: 4 } },
    { ...good, id: "sk" + "7".repeat(12), at: "yesterday" },
    { ...good, id: "sk" + "8".repeat(12), parent: { kind: "sketch", id: "sk" + "9".repeat(12) } },
  );
  s.data.set(BOOK_KEY, JSON.stringify(stored));
  const book = readBook(s);
  assert.deepEqual(
    book.sketches.map((x) => x.id),
    [good.id],
  );
  // what could not be read is kept, not lost, when the book is written again
  must(keep(s, input({ cut: { start: 0, end: 9_000 } })));
  assert.ok(JSON.parse(s.data.get(BOOK_KEY) ?? "{}").sketches.length > 2);
});

test("text that is not a book, or is far too large, is an empty book and not an error", () => {
  for (const text of [null, "", "not json", "[]", "7", '{"v":1}', "x".repeat(300_000)])
    assert.deepEqual(parseBook(text).sketches, [], String(text).slice(0, 20));
});

test("a store from a newer version is left exactly as it is and is never written", () => {
  const s = new Fake();
  const future = JSON.stringify({ v: 2, sketches: [{ anything: true }], extra: "kept" });
  s.data.set(BOOK_KEY, future);
  assert.equal(readBook(s).newer, true);
  assert.deepEqual(keep(s, input()), { ok: false, why: "newer" });
  assert.deepEqual(discard(s, "sk" + "0".repeat(12)), { ok: false, why: "newer" });
  assert.equal(s.data.get(BOOK_KEY), future);
});

test("two tabs: a write reads the store afresh, so one tab's keep is never lost to the other's", () => {
  const s = new Fake();
  const staleA = readBook(s); // tab A looked at an empty book a while ago
  const fromB = must(keep(s, input())).sketch;
  assert.equal(staleA.sketches.length, 0);
  const fromA = must(keep(s, input({ cut: { start: 0, end: 7_000 } }))).sketch;
  assert.deepEqual(
    readBook(s).sketches.map((x) => x.id),
    [fromB.id, fromA.id],
  );
});

test("a local id that is already taken is re-rolled", () => {
  const taken = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = newSketchId(taken);
    assert.equal(taken.has(id), false);
    taken.add(id);
  }
  assert.equal(taken.size, 200);
});

test("the limit refuses the forty-first keep, names the oldest unused sketch, and drops nothing", () => {
  const s = new Fake();
  for (let i = 0; i < MOST_SKETCHES; i++)
    must(keep(s, input({ cut: { start: 0, end: 1_000 + i } }), 1_000 + i));
  assert.deepEqual(keep(s, input({ cut: { start: 0, end: 5_000 } })), { ok: false, why: "limit" });
  const book = readBook(s);
  assert.equal(book.sketches.length, MOST_SKETCHES);
  assert.equal(oldestUnused(book)?.at, 1_000);
});

test("discarding a sketch takes the ones that go on from it, so none is left without a parent, and leaves the bank", () => {
  const s = new Fake();
  const root = must(keep(s, input())).sketch;
  const child = must(
    keep(s, input({ parent: { kind: "sketch", id: root.id }, title: "child" })),
  ).sketch;
  const grand = must(
    keep(s, input({ parent: { kind: "sketch", id: child.id }, title: "grand" })),
  ).sketch;
  const other = must(keep(s, input({ cut: { start: 0, end: 3_000 } }))).sketch;
  assert.deepEqual(
    below(readBook(s), root.id)
      .map((x) => x.id)
      .sort(),
    [child.id, grand.id].sort(),
  );
  const gone = must(discard(s, root.id));
  assert.deepEqual(gone.removed.sort(), [root.id, child.id, grand.id].sort());
  assert.deepEqual(
    readBook(s).sketches.map((x) => x.id),
    [other.id],
  );
});

test("a sketch cannot go on from a sketch that is not in the book", () => {
  const s = new Fake();
  const r = keep(s, input({ parent: { kind: "sketch", id: "sk" + "a".repeat(12) } }));
  assert.deepEqual(r, { ok: false, why: "invalid" });
});

test("a title can change until the sketch is published; what it became is recorded once", () => {
  const s = new Fake();
  const k = must(keep(s, input())).sketch;
  must(rename(s, k.id, "new name"));
  assert.equal(readBook(s).sketches[0]?.title, "new name");
  assert.equal(rename(s, k.id, "x".repeat(61)).ok, false);
  must(markPublished(s, k.id, STAGE));
  must(markPublished(s, k.id, "aaaaaaaaaaaa")); // a second mark changes nothing
  assert.equal(readBook(s).sketches[0]?.publishedAs, STAGE);
  assert.deepEqual(rename(s, k.id, "later"), { ok: false, why: "published" });
});

test("the same try kept twice is allowed and each knows its twin", () => {
  const s = new Fake();
  const a = must(keep(s, input(), 1)).sketch;
  const b = must(keep(s, input({ title: "again" }), 2)).sketch;
  const book = readBook(s);
  assert.equal(twinOf(book, b)?.id, a.id);
  assert.equal(twinOf(book, a), null, "the first is not a twin of the later one");
});
