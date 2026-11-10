// Expected values are worked by hand from the definition (percent = p/q, semitones = 12 * log2(p/q)),
// not recomputed with the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSpeed } from "./speed.ts";

const cases: Array<[number, number, string, string]> = [
  [1, 1, "100%", "same pitch"],
  [3, 2, "150%", "a fifth up"], // 7.02 semitones
  [2, 3, "67%", "a fifth down"], // 66.67 rounds to 67
  [1, 2, "50%", "an octave down"],
  [2, 1, "200%", "an octave up"],
  [4, 3, "133%", "a fourth up"], // 4.98 semitones
  [3, 1, "300%", "an octave and a fifth up"], // 19.02 semitones
  [1, 3, "33%", "an octave and a fifth down"],
  [9, 8, "113%", "a whole step up"], // 2.04 semitones; 112.5 rounds half up
];

for (const [p, q, percent, interval] of cases) {
  test(`${p}/${q} reads as ${percent}, ${interval}`, () => {
    const speed = describeSpeed(p, q);
    assert.equal(speed.percent, percent);
    assert.equal(speed.interval, interval);
  });
}

test("a ratio that falls between two intervals is marked approximate", () => {
  // 5/4 is 3.86 semitones: 14 cents short of a major third.
  assert.equal(describeSpeed(5, 4).interval, "a major third up");
  assert.equal(describeSpeed(5, 4).approximate, true);
  // 3/2 is 2 cents from a tempered fifth: close enough to call exact.
  assert.equal(describeSpeed(3, 2).approximate, false);
});

test("a speed that cannot exist is refused, not shown", () => {
  for (const [p, q] of [
    [0, 1],
    [1, 0],
    [-1, 2],
    [1.5, 2],
    [Number.NaN, 1],
  ] as const) {
    assert.throws(() => describeSpeed(p, q), RangeError, `${p}/${q}`);
  }
});
