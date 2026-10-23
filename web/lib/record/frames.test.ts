import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameGovernor } from "./frames.ts";

function feed(governor: FrameGovernor, interval: number, frames: number, from = 0): number {
  let t = from;
  for (let i = 0; i < frames; i++) {
    t += interval;
    governor.frame(t);
  }
  return t;
}

test("steady 60 frames a second keeps the live drawing", () => {
  const g = new FrameGovernor();
  feed(g, 1000 / 60, 300);
  assert.equal(g.degraded, false);
});

test("a run of slow frames switches to the cached drawing, and it stays there", () => {
  const g = new FrameGovernor();
  const t = feed(g, 60, 40); // about 17 frames a second
  assert.equal(g.degraded, true);
  feed(g, 1000 / 60, 300, t);
  assert.equal(g.degraded, true, "it does not flap back");
});

test("one long frame (a tab switch, a garbage collection) is not enough", () => {
  const g = new FrameGovernor();
  let t = feed(g, 1000 / 60, 100);
  t += 400;
  g.frame(t);
  feed(g, 1000 / 60, 100, t);
  assert.equal(g.degraded, false);
});

test("nothing is judged before there are enough frames to judge", () => {
  const g = new FrameGovernor();
  feed(g, 80, 5);
  assert.equal(g.degraded, false);
});

test("frames before a pause are not measured against frames after it: a pause is not a slow frame", () => {
  const g = new FrameGovernor();
  let t = feed(g, 1000 / 60, 40);
  // The loop stops (paused, or only redrawn when the visitor acts), and starts again much later.
  g.pause();
  t += 60_000;
  for (let i = 0; i < 40; i++) {
    t += 1000 / 60;
    g.frame(t);
  }
  assert.equal(g.degraded, false);
});

test("without a pause the same gap would count, which is why the loop says when it stops", () => {
  const g = new FrameGovernor();
  let t = feed(g, 1000 / 60, 10);
  for (let i = 0; i < 25; i++) {
    t += 500; // a person pressing keys, one redraw each
    g.frame(t);
  }
  assert.equal(g.degraded, true);
});
