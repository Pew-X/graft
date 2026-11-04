import assert from "node:assert/strict";
import { test } from "node:test";
import { loopFraction, playheadFrame, steppedFraction } from "./playhead.ts";

test("the loop fraction wraps at the length of the loop", () => {
  assert.equal(loopFraction(0, 2), 0);
  assert.equal(loopFraction(0.5, 2), 0.25);
  assert.equal(loopFraction(2, 2), 0);
  assert.equal(loopFraction(5, 2), 0.5);
});

test("nothing is playing when the numbers cannot be a position", () => {
  assert.equal(loopFraction(-1, 2), null);
  assert.equal(loopFraction(1, 0), null);
  assert.equal(loopFraction(Number.NaN, 2), null);
  assert.equal(loopFraction(1, Number.POSITIVE_INFINITY), null);
});

test("the playhead is the same fraction through the kept part", () => {
  assert.equal(playheadFrame({ start: 1000, end: 3000 }, 0), 1000);
  assert.equal(playheadFrame({ start: 1000, end: 3000 }, 0.5), 2000);
  assert.equal(playheadFrame({ start: 1000, end: 3000 }, 1), 3000);
});

test("an inverted cut still has a line between its two ends, and the fraction is held in range", () => {
  assert.equal(playheadFrame({ start: 3000, end: 1000 }, 0.25), 1500);
  assert.equal(playheadFrame({ start: 1000, end: 3000 }, -1), 1000);
  assert.equal(playheadFrame({ start: 1000, end: 3000 }, 7), 3000);
});

test("reduced motion steps the line in four", () => {
  assert.equal(steppedFraction(0), 0);
  assert.equal(steppedFraction(0.24), 0);
  assert.equal(steppedFraction(0.25), 0.25);
  assert.equal(steppedFraction(0.99), 0.75);
  assert.equal(steppedFraction(1), 0.75);
});
