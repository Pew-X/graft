import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, describeFlip, intervalPhrase, secondsText } from "./describe.ts";

test("the interval is said direction first, like the seeded titles", () => {
  assert.equal(intervalPhrase(3, 2), "up a fifth");
  assert.equal(intervalPhrase(1, 2), "down an octave");
  assert.equal(intervalPhrase(1, 1), "same pitch");
  assert.equal(intervalPhrase(2, 1), "up an octave");
});

test("a ratio off the interval says so, instead of naming the interval as if exact", () => {
  assert.equal(intervalPhrase(1039, 1024), "about the same pitch");
  assert.equal(intervalPhrase(4096, 2048 + 59), "up about an octave");
});

test("seconds are at most two places with trailing zeros trimmed, and always a number", () => {
  assert.equal(secondsText(43_200), "0.9");
  assert.equal(secondsText(72_000), "1.5");
  assert.equal(secondsText(48_000), "1");
  assert.equal(secondsText(15_840), "0.33");
});

test("the age is the largest whole unit, singular for one, and never negative", () => {
  const now = 10_000_000_000;
  assert.equal(ago(now, now), "just now");
  assert.equal(ago(now + 5_000, now), "just now");
  assert.equal(ago(now - 59_000, now), "just now");
  assert.equal(ago(now - 60_000, now), "1 minute ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3 hours ago");
  assert.equal(ago(now - 3 * 86_400_000, now), "3 days ago");
  assert.equal(ago(now - 90 * 86_400_000, now), "3 months ago");
  assert.equal(ago(now - 800 * 86_400_000, now), "2 years ago");
});

test("a flip is described by its computed facts only", () => {
  const now = 10_000_000_000;
  assert.equal(
    describeFlip({ speed: { p: 3, q: 2 }, frames: 43_200, createdAtMs: now - 3 * 86_400_000 }, now),
    "up a fifth, 0.9 s, 3 days ago",
  );
});
