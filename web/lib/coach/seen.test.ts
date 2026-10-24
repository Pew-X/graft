// The coach's seen flag: it remembers when it can, and never gets in the way when it cannot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COACH_KEY, coachSeen, markCoachSeen } from "./seen.ts";

function memory(): {
  data: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
} {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

test("a fresh browser has not seen it; after marking, it has, under one key and nothing else", () => {
  const store = memory();
  assert.equal(coachSeen(store), false);
  markCoachSeen(store);
  assert.equal(coachSeen(store), true);
  assert.deepEqual([...store.data.entries()], [[COACH_KEY, "seen"]]);
});

test("a stored value that is not the flag does not count", () => {
  const store = memory();
  store.setItem(COACH_KEY, "yes please");
  assert.equal(coachSeen(store), false);
});

test("a browser that blocks storage shows the coach again and never throws", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(coachSeen(blocked), false);
  assert.doesNotThrow(() => markCoachSeen(blocked));
  assert.equal(coachSeen(null), false);
  assert.doesNotThrow(() => markCoachSeen(null));
});
