import assert from "node:assert/strict";
import { test } from "node:test";
import { outline, peaks } from "./peaks.ts";

test("each bucket holds the lowest and highest sample of its stretch, so a spike is never averaged away", () => {
  const s = new Int16Array(1_000);
  s[510] = 9_000;
  s[120] = -7_000;
  const p = peaks(s, 10);
  assert.equal(p.length, 10);
  assert.deepEqual(p[5], [0, 9_000]);
  assert.deepEqual(p[1], [-7_000, 0]);
  assert.deepEqual(p[9], [0, 0]);
});

test("peaks cover every frame once, including when the length does not divide evenly", () => {
  const s = Int16Array.from({ length: 1_001 }, (_, i) => i + 1);
  const p = peaks(s, 7);
  assert.equal(p.length, 7);
  assert.equal(p.at(-1)![1], 1_001, "the last frame lands in the last bucket");
  assert.equal(p[0]![0], 1);
});

test("fewer frames than buckets gives one bucket per frame, never empty buckets with stale numbers", () => {
  const p = peaks(Int16Array.of(5, -5, 3), 10);
  assert.equal(p.length, 3);
  assert.deepEqual(p, [
    [5, 5],
    [-5, -5],
    [3, 3],
  ]);
});

test("no sound and no buckets are both empty, not an error", () => {
  assert.deepEqual(peaks(new Int16Array(0), 10), []);
  assert.deepEqual(peaks(Int16Array.of(1, 2), 0), []);
});

test("the outline of silence is a flat line on the middle, and of full scale reaches near both edges", () => {
  assert.match(outline([[0, 0]]), /^M0 50\.00 L1 50\.00 L1 50\.00 L0 50\.00 Z$/);
  const loud = outline([[-32768, 32767]]);
  assert.match(loud, /^M0 2\.00/, "the top is 2 units from the edge");
  assert.match(loud, /L0 98\.00 L1 98\.00 Z$|L1 98\.00 L0 98\.00 Z$/, "and the bottom 98");
});

test("the outline walks right along the tops and back left along the bottoms, so the shape never crosses itself", () => {
  const d = outline([
    [-100, 200],
    [-300, 400],
  ]);
  const xs = d
    .replace(/^M|\sZ$/g, "")
    .split(" L")
    .map((pair) => Number(pair.split(" ")[0]));
  assert.deepEqual(xs, [0, 1, 1, 2, 2, 1, 1, 0]);
});

test("an empty list of peaks has no outline", () => {
  assert.equal(outline([]), "");
});
