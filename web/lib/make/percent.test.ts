import assert from "node:assert/strict";
import { test } from "node:test";
import { typedSpeed } from "./percent.ts";
import { entryAt } from "./speed.ts";

test("100 is the sound unchanged, exactly", () => {
  const r = typedSpeed("100");
  assert.ok(r.ok);
  assert.deepEqual([entryAt(r.stop).p, entryAt(r.stop).q], [1, 1]);
  assert.equal(r.snapped, false);
  assert.equal(r.percent, "100%");
});

test("a percent sign, spaces and a decimal comma are accepted", () => {
  for (const text of ["100%", " 100 % ", "100.0", "100,00"]) {
    const r = typedSpeed(text);
    assert.ok(r.ok, text);
    assert.equal(r.percent, "100%");
  }
});

test("a number between two stops snaps to the nearest and says so", () => {
  const r = typedSpeed("148");
  assert.ok(r.ok);
  assert.equal(r.snapped, true);
  assert.match(r.percent, /^1(4[89]|50)%$/);
  assert.equal(typedSpeed("150").ok && (typedSpeed("150") as { snapped: boolean }).snapped, false);
});

test("the ends of the range are the ends of the table", () => {
  const low = typedSpeed("25");
  const high = typedSpeed("400");
  assert.ok(low.ok && high.ok);
  assert.equal(low.stop, 0);
  assert.equal(low.snapped, false);
  assert.equal(entryAt(high.stop).p, 4);
});

test("out of range, empty and not a number are refused with a reason", () => {
  assert.deepEqual(typedSpeed("24.99"), { ok: false, why: "range" });
  assert.deepEqual(typedSpeed("401"), { ok: false, why: "range" });
  assert.deepEqual(typedSpeed("  "), { ok: false, why: "empty" });
  for (const bad of ["abc", "1e3", "-50", "12345", "1.234", "10 0"]) {
    assert.deepEqual(typedSpeed(bad), { ok: false, why: "number" }, bad);
  }
});
