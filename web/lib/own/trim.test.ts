import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FRAMES } from "./source.ts";
import {
  POSITION_STEP,
  VIEW_FRAMES,
  clampPosition,
  clock,
  lastPosition,
  needsWindow,
  startingCut,
  windowAt,
} from "./trim.ts";

const RATE = 48_000;

test("a recording of a minute or less is shown whole; a longer one needs the window", () => {
  assert.equal(needsWindow(VIEW_FRAMES), false);
  assert.equal(needsWindow(VIEW_FRAMES + 1), true);
  assert.deepEqual(windowAt(30 * RATE, 5 * RATE), { start: 0, end: 30 * RATE });
});

test("the window always ends inside the recording, and moves a second at a time", () => {
  const total = 257 * RATE;
  assert.equal(lastPosition(total), 197 * RATE);
  assert.equal(clampPosition(total, -5), 0);
  assert.equal(clampPosition(total, total), 197 * RATE);
  assert.equal(clampPosition(total, 12.4 * RATE) % POSITION_STEP, 0);
  const w = windowAt(total, 100 * RATE);
  assert.equal(w.end - w.start, VIEW_FRAMES);
  assert.equal(windowAt(total, 10 * total).end, total);
});

test("a thirty minute recording can be reached to its very end", () => {
  const total = 30 * 60 * RATE;
  const last = windowAt(total, total);
  assert.equal(last.end, total);
  assert.equal(last.end - last.start, VIEW_FRAMES);
});

test("the brackets start on the window's first fifteen seconds, or all of a shorter one", () => {
  assert.deepEqual(startingCut(VIEW_FRAMES), { start: 0, end: MAX_FRAMES });
  assert.deepEqual(startingCut(5 * RATE), { start: 0, end: 5 * RATE });
});

test("moments read as minutes and seconds, with hours past the hour", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(257 * RATE), "4:17");
  assert.equal(clock(3725 * RATE), "1:02:05");
  assert.equal(clock(-1), "0:00");
});
