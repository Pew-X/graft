// The coach's drawing and placement, worked as plain geometry. Each test names what it protects.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrowPath,
  edgeToward,
  loopPath,
  placeCard,
  seeded,
  underlinePath,
  type Rect,
} from "./marks.ts";

const numbers = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
const view = { w: 1280, h: 720 };

test("the same seed draws the same line, a different seed a different one", () => {
  const target: Rect = { x: 500, y: 600, w: 100, h: 50 };
  assert.equal(loopPath(target, 10, 7), loopPath(target, 10, 7));
  assert.notEqual(loopPath(target, 10, 7), loopPath(target, 10, 8));
  const a = seeded(1);
  const b = seeded(1);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("a loop goes round the target: every point is outside the target and near it", () => {
  const target: Rect = { x: 500, y: 600, w: 100, h: 50 };
  const pad = 12;
  const n = numbers(loopPath(target, pad, 3));
  assert.ok(n.length > 100, "a drawn stroke has many points");
  for (let i = 0; i < n.length; i += 2) {
    const x = n[i]!;
    const y = n[i + 1]!;
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    // outside the box (the pad leaves room), and not wandering far away
    const inside =
      x > target.x + 2 &&
      x < target.x + target.w - 2 &&
      y > target.y + 2 &&
      y < target.y + target.h - 2;
    assert.equal(inside, false, `point ${i / 2} is inside the target`);
    assert.ok(x > target.x - pad * 3 && x < target.x + target.w + pad * 3);
    assert.ok(y > target.y - pad * 3 && y < target.y + target.h + pad * 3);
  }
});

test("an arrow ends exactly at its target, and its head is two strokes meeting there", () => {
  const from = { x: 100, y: 100 };
  const to = { x: 400, y: 300 };
  const { shaft, head } = arrowPath(from, to, 5);
  const s = numbers(shaft);
  assert.deepEqual([s[0], s[1]], [100, 100]);
  assert.deepEqual([s[4], s[5]], [400, 300]);
  const h = numbers(head);
  assert.deepEqual([h[2], h[3]], [400, 300], "the two strokes of the head meet at the tip");
  for (const v of [...s, ...h]) assert.ok(Number.isFinite(v));
  // each stroke of the head is a short line, not a second shaft
  assert.ok(Math.hypot(h[0]! - 400, h[1]! - 300) < 30);
  assert.ok(Math.hypot(h[4]! - 400, h[5]! - 300) < 30);
});

test("an arrow between the same two points never fails", () => {
  const { shaft, head } = arrowPath({ x: 10, y: 10 }, { x: 10, y: 10 }, 1);
  for (const v of [...numbers(shaft), ...numbers(head)]) assert.ok(Number.isFinite(v));
});

test("the note goes above the target when there is room, and covers neither it nor the edge", () => {
  const target: Rect = { x: 560, y: 640, w: 160, h: 50 };
  const card = { w: 300, h: 150 };
  const spot = placeCard(target, card, view);
  assert.equal(spot.side, "above");
  assert.ok(spot.y + card.h <= target.y, "it does not cover the target");
  assert.ok(spot.x >= 16 && spot.x + card.w <= view.w - 16 && spot.y >= 16);
});

test("a preferred side is used when it fits, and the usual order takes over when it does not", () => {
  const card = { w: 300, h: 150 };
  const target: Rect = { x: 100, y: 330, w: 160, h: 50 };
  assert.equal(placeCard(target, card, view, 16, 28, ["right", "below"]).side, "right");
  const edge: Rect = { x: 1100, y: 330, w: 160, h: 50 };
  // no room to the right of a target at the edge: the next preference is used
  assert.equal(placeCard(edge, card, view, 16, 28, ["right", "below"]).side, "below");
  assert.equal(placeCard(edge, card, view).side, "above", "without a preference, above first");
});

test("with no room above, it goes below; with none either way, beside", () => {
  const card = { w: 300, h: 150 };
  const top: Rect = { x: 500, y: 30, w: 200, h: 44 };
  assert.equal(placeCard(top, card, view).side, "below");
  const tall: Rect = { x: 100, y: 20, w: 200, h: 690 };
  const beside = placeCard(tall, card, view);
  assert.ok(beside.side === "right" || beside.side === "left");
  assert.ok(beside.x >= 16 && beside.x + card.w <= view.w - 16);
});

test("in every placement the note stays on screen, whatever the target", () => {
  const card = { w: 330, h: 170 };
  const phone = { w: 360, h: 640 };
  for (const [tx, ty, tw, th] of [
    [0, 0, 80, 44],
    [280, 0, 80, 44],
    [140, 590, 100, 48],
    [0, 300, 360, 40],
    [100, 200, 160, 200],
  ] as const) {
    const spot = placeCard({ x: tx, y: ty, w: tw, h: th }, card, phone);
    assert.ok(spot.x >= 0 && spot.x + card.w <= phone.w, `x for ${tx},${ty}`);
    assert.ok(spot.y >= 0 && spot.y + card.h <= phone.h, `y for ${tx},${ty}`);
  }
});

test("an arrow ends just outside the target's edge, on the side the note is on", () => {
  const target: Rect = { x: 500, y: 300, w: 100, h: 50 };
  const above = edgeToward(target, { x: 550, y: 100 });
  assert.ok(above.y < target.y, "ends above the top edge");
  assert.ok(above.x >= target.x && above.x <= target.x + target.w);
  const left = edgeToward(target, { x: 100, y: 325 });
  assert.ok(left.x < target.x, "ends left of the left edge");
  assert.ok(
    Number.isFinite(edgeToward(target, { x: 550, y: 325 }).y),
    "a note over the middle never fails",
  );
});

test("an underline runs the whole width left to right and stays on its own line", () => {
  const d = underlinePath(300, 5);
  assert.equal(d, underlinePath(300, 5), "the same seed draws the same line");
  assert.notEqual(d, underlinePath(300, 6));
  const n = numbers(d);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  assert.equal(xs[0], 0);
  assert.equal(xs.at(-1), 300);
  assert.deepEqual(
    xs,
    [...xs].sort((a, b) => a - b),
    "left to right, never doubling back",
  );
  for (const y of ys) assert.ok(y > 3 && y < 9, `y ${y} stays near the middle of the 12 px box`);
});
