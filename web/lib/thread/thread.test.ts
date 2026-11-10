import assert from "node:assert/strict";
import { test } from "node:test";
import { traceOf } from "../trace/trace.ts";
import { cableAt, threadPath } from "./thread.ts";

const from = { x: 100, y: 50 };
const to = { x: 500, y: 350 };

function points(path: string): Array<[number, number]> {
  return path
    .split(/(?=[ML])/)
    .map((s) => s.slice(1).trim().split(" ").map(Number) as [number, number]);
}

test("the centre line runs from the label to the groove and leaves the label going outward", () => {
  const start = cableAt(from, to, 0);
  const end = cableAt(from, to, 1);
  assert.deepEqual(start.at, from);
  assert.deepEqual(end.at, to);
  assert.ok(start.dir.x > 0.99, "it leans out of the label sideways before it bends");
  assert.ok(end.dir.x > 0.99, "and arrives at the groove the same way");
});

test("a flat trace draws the bare centre line, hand-worked at the middle", () => {
  const mid = points(threadPath(from, to, [0, 0, 0], 10))[1]!;
  // t = 0.5 on a cubic whose handles are 0.45 of the span out: x = 300, y = 200 by symmetry.
  assert.deepEqual(mid, [300, 200]);
});

test("the cable's wobble is the trace, pushed sideways by amp pixels", () => {
  const flat = points(threadPath(from, to, [0, 0, 0], 10))[1]!;
  const up = points(threadPath(from, to, [0, 1, 0], 10))[1]!;
  const moved = Math.hypot(up[0] - flat[0], up[1] - flat[1]);
  assert.ok(Math.abs(moved - 10) < 0.2, `moved ${moved}`);
  // the push is at right angles to the cable: at the middle the cable runs down and to the right
  const dir = cableAt(from, to, 0.5).dir;
  assert.ok(Math.abs((up[0] - flat[0]) * dir.x + (up[1] - flat[1]) * dir.y) < 0.2);
});

test("with a real trace both ends are exactly the label and the groove", () => {
  const p = points(threadPath(from, to, traceOf("e790b6ycz0yd", 96), 9));
  assert.equal(p.length, 96);
  assert.ok(Math.abs(p[0]![0] - from.x) < 0.5 && Math.abs(p[0]![1] - from.y) < 0.5);
  assert.ok(Math.abs(p[95]![0] - to.x) < 0.5 && Math.abs(p[95]![1] - to.y) < 0.5);
});

test("the same id draws the same cable and a different id a different one", () => {
  const a = threadPath(from, to, traceOf("one", 96), 9);
  assert.equal(a, threadPath(from, to, traceOf("one", 96), 9));
  assert.notEqual(a, threadPath(from, to, traceOf("two", 96), 9));
});

test("fewer than two values draw nothing", () => {
  assert.equal(threadPath(from, to, [], 9), "");
  assert.equal(threadPath(from, to, [0.5], 9), "");
});
