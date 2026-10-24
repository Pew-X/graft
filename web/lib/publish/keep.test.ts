// Keeping a manage key in this browser is the maker's choice; it is the only thing graft stores about a maker's publications (the light or dark choice and the first-visit guide's note are not about them).
import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE_KEY, forgetKey, keepKey, keptKeys, type StorageLike } from "./keep.ts";

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test("nothing is stored unless keepKey is called: reading an empty browser gives nothing", () => {
  const s = memory();
  assert.deepEqual(keptKeys(s), {});
  assert.equal(s.data.size, 0);
});

test("a kept key is stored under one name, by publication id, and read back", () => {
  const s = memory();
  assert.equal(keepKey(s, "abc", "k1"), true);
  assert.equal(keepKey(s, "def", "k2"), true);
  assert.deepEqual(keptKeys(s), { abc: "k1", def: "k2" });
  assert.deepEqual([...s.data.keys()], [STORAGE_KEY]);
});

test("forgetting removes one key and leaves the rest; the last one removes the entry", () => {
  const s = memory();
  keepKey(s, "abc", "k1");
  keepKey(s, "def", "k2");
  forgetKey(s, "abc");
  assert.deepEqual(keptKeys(s), { def: "k2" });
  forgetKey(s, "def");
  assert.equal(s.data.size, 0);
});

test("blocked or full storage says no instead of throwing, and a damaged entry reads as empty", () => {
  const blocked: StorageLike = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(keepKey(blocked, "a", "k"), false);
  assert.deepEqual(keptKeys(blocked), {});
  assert.doesNotThrow(() => forgetKey(blocked, "a"));
  const damaged = memory();
  damaged.setItem(STORAGE_KEY, "{not json");
  assert.deepEqual(keptKeys(damaged), {});
  damaged.setItem(STORAGE_KEY, JSON.stringify({ a: 5, b: "ok" }));
  assert.deepEqual(keptKeys(damaged), { b: "ok" }, "only strings are keys");
  assert.equal(keepKey(null, "a", "k"), false, "no storage at all");
});
