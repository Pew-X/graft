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

test("a number whose nearest stop reads differently snaps and says so", () => {
  const r = typedSpeed("210");
  assert.ok(r.ok);
  assert.equal(r.snapped, true);
  assert.equal(r.percent, "209%");
  assert.equal(typedSpeed("150").ok && (typedSpeed("150") as { snapped: boolean }).snapped, false);
});

test("a number whose nearest stop reads the same is just that speed, not a correction", () => {
  for (const typed of ["148", "133", "47.3", "149.6"]) {
    const r = typedSpeed(typed);
    assert.ok(r.ok, typed);
    assert.equal(r.snapped, false, typed);
  }
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
  for (const bad of ["abc", "1e3", "-50", "1.234", "10 0"]) {
    assert.deepEqual(typedSpeed(bad), { ok: false, why: "number" }, bad);
  }
});

test("a number with many digits is out of range, not 'not a number'", () => {
  for (const text of ["99999", "123456", "1234567", "123456789012345678"]) {
    assert.deepEqual(typedSpeed(text), { ok: false, why: "range" }, text);
  }
  // still not numbers: a sign, letters, an empty digit run
  for (const text of ["-5", "abc", "1e9", "12a"]) {
    assert.deepEqual(typedSpeed(text), { ok: false, why: "number" }, text);
  }
});
