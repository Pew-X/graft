import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSteps, dwellFor, restStep, stepAfterAudition } from "./steps.ts";

// Expected values are worked out by hand from the spec: the teaser is the finished flip, then the
// source forward, then rest on the finished flip; a step lasts 2.4 s, shrinking to 1.6 s for long chains.

test("a chain of four plays the finished flip, then source to final, then rests on the finished flip", () => {
  const steps = buildSteps(4);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.stage]),
    [
      ["teaser", 3],
      ["stage", 0],
      ["stage", 1],
      ["stage", 2],
      ["stage", 3],
      ["rest", 3],
    ],
  );
  assert.deepEqual(
    steps.map((s) => s.dwell),
    [2.4, 2.4, 2.4, 2.4, 2.4, null],
  );
});

test("a chain of one is its own teaser, stage and rest", () => {
  assert.deepEqual(
    buildSteps(1).map((s) => [s.kind, s.stage]),
    [
      ["teaser", 0],
      ["stage", 0],
      ["rest", 0],
    ],
  );
});

test("a chain of two", () => {
  assert.deepEqual(
    buildSteps(2).map((s) => [s.kind, s.stage]),
    [
      ["teaser", 1],
      ["stage", 0],
      ["stage", 1],
      ["rest", 1],
    ],
  );
});

test("the dwell is 2.4 s up to eight stages and shrinks to 20 s / stages, never below 1.6 s", () => {
  assert.equal(dwellFor(1), 2.4);
  assert.equal(dwellFor(8), 2.4, "20/8 = 2.5 is clamped to 2.4");
  assert.ok(Math.abs(dwellFor(10) - 2) < 1e-12);
  assert.ok(Math.abs(dwellFor(12) - 20 / 12) < 1e-12, "a 12-stage chain");
  assert.equal(dwellFor(13), 1.6, "20/13 = 1.54 is clamped up to 1.6");
  assert.equal(dwellFor(50), 1.6);
});

test("a twelve-stage chain has fourteen steps and plays through in about twenty seconds", () => {
  const steps = buildSteps(12);
  assert.equal(steps.length, 14);
  const total = steps.reduce((sum, s) => sum + (s.dwell ?? 0), 0);
  assert.ok(total > 20 && total < 22, `${total} s for teaser plus twelve stages`);
});

test("rest is the last step and the only one with no end", () => {
  for (const n of [1, 2, 4, 12]) {
    const steps = buildSteps(n);
    assert.equal(restStep(n), steps.length - 1);
    assert.deepEqual(
      steps.filter((s) => s.dwell === null).map((s) => s.kind),
      ["rest"],
    );
    assert.equal(steps[steps.length - 1]?.kind, "rest");
  }
});

test("after an audition roll resumes at that stage's step, and at rest for the finished flip", () => {
  assert.equal(stepAfterAudition(4, 0), 1);
  assert.equal(stepAfterAudition(4, 2), 3);
  assert.equal(stepAfterAudition(4, 3), 5, "the finished flip has been heard in full: go to rest");
  assert.equal(stepAfterAudition(1, 0), 2);
});

test("a chain needs at least one stage", () => {
  assert.throws(() => buildSteps(0), RangeError);
  assert.throws(() => buildSteps(1.5), RangeError);
  assert.throws(() => restStep(-1), RangeError);
});
