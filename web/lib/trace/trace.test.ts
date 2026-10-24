// A flip's trace is a picture drawn from its public id. Each test names what it protects.
import assert from "node:assert/strict";
import { test } from "node:test";
import { seedOf, traceOf, tracePath } from "./trace.ts";

test("the same id always draws the same line, and different ids draw different ones", () => {
  assert.deepEqual(traceOf("es1418qka9yt"), traceOf("es1418qka9yt"));
  const ids = ["es1418qka9yt", "4bx1vhgn2dze", "k3m9p0aa1qwe", "zzzzzzzzzzzz", "a"];
  const seen = new Set(
    ids.map((id) =>
      traceOf(id)
        .map((v) => v.toFixed(3))
        .join(","),
    ),
  );
  assert.equal(seen.size, ids.length, "no two of these ids draw the same line");
});

test("every value is a finite number between -1 and 1, and the line starts and ends at rest", () => {
  for (const id of ["a", "es1418qka9yt", "", "ünïcode-id", "x".repeat(500)]) {
    const v = traceOf(id, 120);
    assert.equal(v.length, 120);
    for (const x of v) assert.ok(Number.isFinite(x) && x >= -1 && x <= 1, `${id}: ${x}`);
    assert.ok(Math.abs(v[0]!) < 1e-9, "starts at rest");
    assert.ok(Math.abs(v.at(-1)!) < 0.05, "ends near rest");
    assert.ok(Math.max(...v.map(Math.abs)) > 0.1, "has something to see");
  }
});

test("the number of points asked for is the number drawn, even one or none", () => {
  assert.equal(traceOf("a", 1).length, 1);
  assert.equal(traceOf("a", 0).length, 0);
  assert.equal(tracePath([], 100, 40), "");
  assert.match(tracePath([0], 100, 40), /^M0 20$/);
});

test("the path stays inside its box", () => {
  const d = tracePath(traceOf("es1418qka9yt", 120), 300, 80);
  const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  for (let i = 0; i < nums.length; i += 2) {
    assert.ok(nums[i]! >= 0 && nums[i]! <= 300);
    assert.ok(nums[i + 1]! >= 0 && nums[i + 1]! <= 80);
  }
});

test("the seed depends on every character of the id", () => {
  assert.notEqual(seedOf("abc"), seedOf("abd"));
  assert.notEqual(seedOf("abc"), seedOf("bac"));
});
