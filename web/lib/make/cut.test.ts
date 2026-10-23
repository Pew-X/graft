// The arithmetic of a cut, with the limits the service enforces (spec 4.2). Each test names the
// guarantee it protects.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS,
  checkCut,
  checkOutput,
  checkSpeed,
  cutSlice,
  outputFrames,
  refusal,
  seconds,
  snapToZeroCrossing,
} from "./cut.ts";

test("output length is floor((L - 1) * q / p) + 1: the renderer's own rule, worked by hand", () => {
  assert.equal(outputFrames(43_200, 3, 2), 28_800); // the seeded chain's first flip
  assert.equal(outputFrames(23_040, 2, 3), 34_559); // its second
  assert.equal(outputFrames(28_800, 1, 2), 57_599); // (28799 * 2) + 1... floor((28800-1)*2/1)+1
  assert.equal(outputFrames(1, 3, 2), 1);
  assert.equal(outputFrames(480, 4, 1), 120);
  assert.equal(outputFrames(480, 1, 4), 1_917); // floor(479 * 4) + 1
});

test("output length stays exact at the largest cut and the most awkward ratios (no float rounding)", () => {
  const exact = (l: number, p: number, q: number) =>
    Number((BigInt(l - 1) * BigInt(q)) / BigInt(p)) + 1;
  for (const [l, p, q] of [
    [480_000, 1_048_576, 1_048_575],
    [480_000, 1_048_575, 1_048_576],
    [479_999, 262_145, 1_048_576],
    [480_000, 1, 4],
    [480_000, 4, 1],
    [123_457, 7, 11],
  ] as const) {
    assert.equal(outputFrames(l, p, q), exact(l, p, q), `${l} at ${p}/${q}`);
  }
});

test("a cut shorter than 480 frames is refused with the numbers in the message", () => {
  const problem = checkCut({ start: 100, end: 579 }, 48_000);
  assert.equal(problem?.kind, "cutShort");
  assert.match(refusal(problem!), /480/);
  assert.equal(checkCut({ start: 100, end: 580 }, 48_000), null, "exactly 480 is allowed");
});

test("a cut longer than 10 seconds is refused; exactly 480,000 frames is allowed", () => {
  assert.equal(checkCut({ start: 0, end: 480_001 }, 720_000)?.kind, "cutLong");
  assert.equal(checkCut({ start: 0, end: 480_000 }, 720_000), null);
});

test("an inverted or empty cut is refused as inverted, not as short", () => {
  assert.equal(checkCut({ start: 900, end: 100 }, 48_000)?.kind, "cutInverted");
  assert.equal(checkCut({ start: 900, end: 900 }, 48_000)?.kind, "cutInverted");
});

test("a cut outside the sound is refused", () => {
  assert.equal(checkCut({ start: 0, end: 48_001 }, 48_000)?.kind, "cutOutside");
  assert.equal(checkCut({ start: -1, end: 1_000 }, 48_000)?.kind, "cutOutside");
  assert.equal(
    checkCut({ start: 0.5, end: 1_000 }, 48_000)?.kind,
    "cutOutside",
    "whole frames only",
  );
});

test("a ratio outside 1/4 to 4, or with a term over 2^20, or not whole numbers, is refused", () => {
  assert.equal(checkSpeed(1, 4), null);
  assert.equal(checkSpeed(4, 1), null);
  assert.equal(checkSpeed(1, 5)?.kind, "speedRange");
  assert.equal(checkSpeed(5, 1)?.kind, "speedRange");
  assert.equal(checkSpeed(1_048_577, 1_048_576)?.kind, "speedTerms");
  assert.equal(checkSpeed(0, 1)?.kind, "speedTerms");
  assert.equal(checkSpeed(1.5, 1)?.kind, "speedTerms");
});

test("an output under 480 or over 960,000 frames is refused before anything is sent", () => {
  assert.equal(checkOutput(479)?.kind, "outputShort");
  assert.equal(checkOutput(480), null);
  assert.equal(checkOutput(960_000), null);
  assert.equal(checkOutput(960_001)?.kind, "outputLong");
});

test("every refusal has a plain sentence naming the limit it hit, with no placeholder left over", () => {
  const all = [
    checkCut({ start: 0, end: 10 }, 48_000),
    checkCut({ start: 0, end: 480_001 }, 720_000),
    checkCut({ start: 5, end: 2 }, 48_000),
    checkCut({ start: 0, end: 50_000 }, 48_000),
    checkSpeed(1, 9),
    checkSpeed(0, 1),
    checkOutput(10),
    checkOutput(960_001),
  ];
  for (const p of all) {
    assert.ok(p);
    const text = refusal(p);
    assert.ok(text.length > 15, text);
    assert.doesNotMatch(text, /\{/);
  }
});

test("the limits are the service's (spec 4.2)", () => {
  assert.deepEqual(LIMITS, { minFrames: 480, maxCutFrames: 480_000, maxOutputFrames: 960_000 });
});

test("the slice a cut names is [start, end): the first frame in, the end frame out", () => {
  const source = Int16Array.from({ length: 2_000 }, (_, i) => i);
  const slice = cutSlice(source, { start: 600, end: 1_100 });
  assert.equal(slice.length, 500);
  assert.equal(slice[0], 600);
  assert.equal(slice.at(-1), 1_099);
});

test("snapping moves a boundary to the nearest zero crossing and never past the window", () => {
  // A square-ish wave that crosses upward at 100, 300, 500 and downward at 200, 400.
  const s = new Int16Array(700);
  for (let i = 0; i < 700; i++) s[i] = Math.floor(i / 100) % 2 === 1 ? 1000 : -1000;
  assert.equal(snapToZeroCrossing(s, 110, 50), 100);
  assert.equal(snapToZeroCrossing(s, 190, 50), 200);
  assert.equal(snapToZeroCrossing(s, 250, 50), 200, "a tie goes to the earlier crossing");
  assert.equal(snapToZeroCrossing(s, 250, 40), 250, "nothing in the window: unchanged");
});

test("snapping a boundary on silence, or one already on a crossing, leaves it alone", () => {
  const silent = new Int16Array(1_000);
  assert.equal(snapToZeroCrossing(silent, 500, 200), 500);
  const s = Int16Array.from({ length: 1_000 }, (_, i) => (i < 500 ? -5 : 5));
  assert.equal(snapToZeroCrossing(s, 500, 200), 500);
});

test("snapping stays inside the sound at both ends", () => {
  const sine = Int16Array.from({ length: 4_800 }, (_, i) => Math.round(8_000 * Math.sin(i / 20)));
  for (const frame of [0, 1, 4_799, 4_800]) {
    const out = snapToZeroCrossing(sine, frame, 240);
    assert.ok(out >= 0 && out <= sine.length, `${frame} -> ${out}`);
  }
});

test("seconds reads a frame count to the millisecond", () => {
  assert.equal(seconds(43_200), "0.900");
  assert.equal(seconds(480), "0.010");
  assert.equal(seconds(0), "0.000");
  assert.equal(seconds(480_000), "10.000");
});
