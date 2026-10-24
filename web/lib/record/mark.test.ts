// Marking a part on the record: how two places become a cut the make page accepts. Worked by hand:
// a stage of 1.2 s is 57,600 frames at 48 kHz, so a mark from 0.25 to 0.75 is frames 14,400 to 43,200.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_FRAMES,
  MIN_FRAMES,
  makeAddress,
  markBetween,
  markFrames,
  markSeconds,
} from "./mark.ts";

test("two places in either order make one mark, in order and inside the stage", () => {
  assert.deepEqual(markBetween(2, 0.75, 0.25), { stage: 2, from: 0.25, to: 0.75 });
  assert.deepEqual(markBetween(0, -3, 7), { stage: 0, from: 0, to: 1 });
  assert.deepEqual(markBetween(1, Number.NaN, 0.5), { stage: 1, from: 0, to: 0.5 });
});

test("a mark becomes whole frames of the stage, worked by hand", () => {
  assert.deepEqual(markFrames(markBetween(0, 0.25, 0.75), 57_600), { start: 14_400, end: 43_200 });
  assert.deepEqual(markFrames(markBetween(0, 0, 1), 57_600), { start: 0, end: 57_600 });
});

test("a tap is not a part: under 480 frames is nothing", () => {
  assert.equal(markFrames(markBetween(0, 0.5, 0.5), 57_600), null);
  const justUnder = (MIN_FRAMES - 1) / 57_600;
  assert.equal(markFrames(markBetween(0, 0.5, 0.5 + justUnder), 57_600), null);
  const exactly = MIN_FRAMES / 57_600;
  assert.deepEqual(markFrames(markBetween(0, 0.5, 0.5 + exactly), 57_600), {
    start: 28_800,
    end: 29_280,
  });
});

test("a mark longer than the renderer takes is shortened to its limit, never refused later", () => {
  const long = 2_000_000; // about 41 s
  const cut = markFrames(markBetween(0, 0, 1), long)!;
  assert.equal(cut.start, 0);
  assert.equal(cut.end - cut.start, MAX_FRAMES);
  const middle = markFrames(markBetween(0, 0.5, 1), long)!;
  assert.equal(middle.end - middle.start, MAX_FRAMES);
});

test("a stage with no audio, or too little, gives no cut and never throws", () => {
  assert.equal(markFrames(markBetween(0, 0, 1), 0), null);
  assert.equal(markFrames(markBetween(0, 0, 1), 100), null);
  assert.equal(markFrames(markBetween(0, 0, 1), Number.NaN), null);
});

test("the make address carries the stage and the cut, encoded", () => {
  assert.equal(makeAddress("es1418qka9yt"), "/make?from=es1418qka9yt");
  assert.equal(
    makeAddress("es1418qka9yt", { start: 14_400, end: 43_200 }),
    "/make?from=es1418qka9yt&cut=14400-43200",
  );
  assert.equal(makeAddress("a b/c", null), "/make?from=a%20b%2Fc");
});

test("the marked part's length in seconds", () => {
  assert.ok(Math.abs(markSeconds(markBetween(0, 0.25, 0.75), 57_600) - 0.6) < 1e-9);
  assert.equal(markSeconds(markBetween(0, 0, 0), 57_600), 0);
});
