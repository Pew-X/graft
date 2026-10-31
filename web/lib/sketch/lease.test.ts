import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageLike } from "./book.ts";
import {
  LEASE_MS,
  leasedElsewhere,
  readChosen,
  refreshLease,
  releaseLease,
  takeLease,
  writeChosen,
} from "./lease.ts";

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

test("one tab holds the lease; another is refused until it is released or goes stale", () => {
  const s = new Fake();
  assert.deepEqual(takeLease(s, "a", 1000), { ok: true });
  assert.deepEqual(takeLease(s, "b", 2000), { ok: false });
  assert.ok(leasedElsewhere(s, "b", 2000));
  assert.deepEqual(takeLease(s, "a", 3000), { ok: true }, "the holder may take it again");
  assert.deepEqual(
    takeLease(s, "b", 3000 + LEASE_MS),
    { ok: true },
    "a closed tab's lease expires",
  );
  releaseLease(s, "a"); // not a's any more: no effect
  assert.ok(leasedElsewhere(s, "a", 3000 + LEASE_MS + 1));
  releaseLease(s, "b");
  assert.deepEqual(takeLease(s, "a", 3000 + LEASE_MS + 2), { ok: true });
});

test("refreshing keeps a live lease alive, and never steals one", () => {
  const s = new Fake();
  takeLease(s, "a", 0);
  refreshLease(s, "a", LEASE_MS - 1);
  assert.deepEqual(takeLease(s, "b", LEASE_MS + 5), { ok: false });
  refreshLease(s, "b", LEASE_MS + 6);
  assert.ok(leasedElsewhere(s, "b", LEASE_MS + 7), "b's refresh did not take a's lease");
});

test("storage that is missing or broken leaves nothing to clash with", () => {
  assert.deepEqual(takeLease(null, "a", 0), { ok: true });
  const s = new Fake();
  s.data.set("graft.sketch-lease", "not json");
  assert.deepEqual(takeLease(s, "a", 0), { ok: true });
});

test("the chosen set round-trips, and anything stored that is not a sketch id is ignored", () => {
  const s = new Fake();
  assert.ok(writeChosen(s, { ids: ["sk" + "0".repeat(12), "sk" + "1".repeat(12)], author: "me" }));
  assert.deepEqual(readChosen(s), {
    ids: ["sk" + "0".repeat(12), "sk" + "1".repeat(12)],
    author: "me",
  });
  s.data.set(
    "graft.sketch-set",
    JSON.stringify({ ids: ["x", 5, "sk" + "0".repeat(12), "sk" + "0".repeat(12)], author: 4 }),
  );
  assert.deepEqual(readChosen(s), { ids: ["sk" + "0".repeat(12)], author: "" });
  s.data.set("graft.sketch-set", "garbage");
  assert.deepEqual(readChosen(s), { ids: [], author: "" });
  writeChosen(s, { ids: [], author: "" });
  assert.equal(s.data.has("graft.sketch-set"), false);
});
