import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  MIN_SPAN,
  clampView,
  frameInView,
  fractionOf,
  isWhole,
  panBy,
  pinchFactor,
  viewAround,
  wheelFactor,
  wholeView,
  zoomAt,
} from "./view.ts";

const TOTAL = 480_000;

test("the whole view is the whole sound, and zooming out past it stays there", () => {
  const whole = wholeView(TOTAL);
  assert.ok(isWhole(whole, TOTAL));
  assert.deepEqual(zoomAt(whole, TOTAL, 1000, 0.1), whole);
});

test("zooming keeps the frame under the cursor in the same place on screen", () => {
  const view = { from: 100_000, to: 300_000 };
  const anchor = 150_000;
  const before = fractionOf(anchor, view);
  const after = zoomAt(view, TOTAL, anchor, 4);
  assert.equal(after.to - after.from, 50_000);
  assert.ok(Math.abs(fractionOf(anchor, after) - before) < 1e-4);
});

test("no zoom goes narrower than the smallest window or outside the sound", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: TOTAL }),
      fc.double({ min: 0.01, max: 1000, noNaN: true }),
      (anchor, factor) => {
        const v = zoomAt(wholeView(TOTAL), TOTAL, anchor, factor);
        assert.ok(v.from >= 0 && v.to <= TOTAL);
        assert.ok(v.to - v.from >= MIN_SPAN);
      },
    ),
  );
});

test("panning stops at both ends and keeps the width", () => {
  const view = { from: 1000, to: 2000 };
  assert.deepEqual(panBy(view, TOTAL, -5000), { from: 0, to: 1000 });
  assert.deepEqual(panBy(view, TOTAL, 10 ** 9), { from: TOTAL - 1000, to: TOTAL });
  assert.deepEqual(panBy(view, TOTAL, 500), { from: 1500, to: 2500 });
});

test("a sound shorter than the smallest window is always shown whole", () => {
  assert.deepEqual(clampView({ from: 10, to: 20 }, 300), { from: 0, to: 300 });
});

test("the view around a cut leaves a margin and stays inside the sound", () => {
  const v = viewAround(100_000, 200_000, TOTAL);
  assert.deepEqual(v, { from: 80_000, to: 220_000 });
  assert.deepEqual(viewAround(0, 10, TOTAL), { from: 0, to: 970 });
  assert.deepEqual(viewAround(200_000, 100_000, TOTAL), v);
});

test("a pointer maps to a whole-sound frame inside the window, clamped to its ends", () => {
  const view = { from: 10_000, to: 20_000 };
  assert.equal(frameInView(50, 0, 100, view), 15_000);
  assert.equal(frameInView(-30, 0, 100, view), 10_000);
  assert.equal(frameInView(500, 0, 100, view), 20_000);
  assert.equal(frameInView(5, 0, 0, view), 10_000);
});

test("the wheel zooms in on a pull up and out on a push down, and a pinch by its ratio", () => {
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(wheelFactor(100) < 1);
  assert.equal(wheelFactor(0), 1);
  assert.equal(wheelFactor(1e9), wheelFactor(240));
  assert.equal(pinchFactor(100, 200), 2);
  assert.equal(pinchFactor(0, 200), 1);
});
