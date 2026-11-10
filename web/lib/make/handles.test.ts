// How the cut's two handles move: by keyboard in exact steps, by pointer to a frame, and where a
// pointer position lands. Pure, so the fiddly arithmetic is tested without a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { frameAt, keyStep, move } from "./handles.ts";

test("arrow keys move a handle one millisecond (48 frames); shift makes it ten, page keys a hundred", () => {
  assert.equal(keyStep("ArrowRight", false), 48);
  assert.equal(keyStep("ArrowLeft", false), -48);
  assert.equal(keyStep("ArrowUp", false), 48);
  assert.equal(keyStep("ArrowDown", false), -48);
  assert.equal(keyStep("ArrowRight", true), 480);
  assert.equal(keyStep("PageUp", false), 4_800);
  assert.equal(keyStep("PageDown", false), -4_800);
  assert.equal(keyStep("a", false), null);
});

test("a handle never leaves the sound: moves are clamped to 0 and the length, and nothing else", () => {
  assert.equal(move(100, -500, 48_000), 0);
  assert.equal(move(47_900, 500, 48_000), 48_000);
  assert.equal(move(1_000, 48, 48_000), 1_048);
});

test("a handle may cross the other one: the cut then reads as inverted and says so, rather than refusing to move", () => {
  assert.equal(move(1_000, -48, 48_000), 952);
});

test("a pointer position becomes the nearest whole frame, clamped to the track", () => {
  assert.equal(frameAt(0, 0, 200, 48_000), 0);
  assert.equal(frameAt(100, 0, 200, 48_000), 24_000);
  assert.equal(frameAt(150, 50, 200, 48_000), 24_000, "the track starts at 50 and is 200 wide");
  assert.equal(frameAt(-30, 0, 200, 48_000), 0);
  assert.equal(frameAt(999, 0, 200, 48_000), 48_000);
  assert.equal(frameAt(1, 0, 3, 10), 3, "rounds to nearest");
});

test("a zero-width track gives frame 0, not a division by zero", () => {
  assert.equal(frameAt(5, 0, 0, 48_000), 0);
});
