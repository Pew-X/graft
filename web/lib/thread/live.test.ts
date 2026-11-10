// When the stage on screen is "live" (its colour takes over the tile, the thread and the ring), and how loud
// it is at the playhead. Each test names the case it protects.
import assert from "node:assert/strict";
import { test } from "node:test";
import { levelAt, liveDye } from "./live.ts";

const base = { playing: true, current: 2, hero: 2, state: "available" as const, dye: 1 as const };

test("the stage on screen is live while it sounds, in its own dye", () => {
  assert.equal(liveDye(base), 1);
  for (const dye of [0, 1, 2, 3] as const) assert.equal(liveDye({ ...base, dye }), dye);
});

test("nothing is live at rest, on pause, or when nothing is current", () => {
  assert.equal(liveDye({ ...base, playing: false }), null);
  assert.equal(liveDye({ ...base, current: null }), null);
});

test("a sound that is not the stage on screen makes nothing live: the cable would start from the wrong tile", () => {
  assert.equal(liveDye({ ...base, current: 0, hero: 2 }), null);
  assert.equal(liveDye({ ...base, current: 3, hero: 2 }), null);
});

test("a stage that cannot be heard is never live", () => {
  for (const state of ["no_longer_here", "held", "unavailable"] as const) {
    assert.equal(liveDye({ ...base, state }), null, state);
  }
});

test("the loudness at the playhead is the peak of the slice it is in, hand-worked", () => {
  const peaks = [0.1, 0.4, 0.8, 0.2];
  // a 4 second stage: each slice is one second
  assert.equal(levelAt(peaks, 0, 4), 0.1);
  assert.equal(levelAt(peaks, 0.99, 4), 0.1);
  assert.equal(levelAt(peaks, 1, 4), 0.4);
  assert.equal(levelAt(peaks, 2.5, 4), 0.8);
  assert.equal(levelAt(peaks, 3.99, 4), 0.2);
});

test("the loudness never leaves 0 to 1, and a missing or odd input is silence, not a crash", () => {
  assert.equal(levelAt([0.5, 0.9], 4, 4), 0.9, "the end of the stage is its last slice");
  assert.equal(levelAt([0.5, 0.9], -1, 4), 0.5);
  assert.equal(levelAt([], 1, 4), 0);
  assert.equal(levelAt([0.5], 1, 0), 0);
  assert.equal(levelAt([0.5], Number.NaN, 4), 0);
  assert.equal(levelAt([2, -3], 0, 4), 1);
  assert.equal(levelAt([2, -3], 3, 4), 0);
});
