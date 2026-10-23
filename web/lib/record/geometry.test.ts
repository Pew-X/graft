// Worked by hand. A 3-stage chain has 4 bands (3 stages and the empty slot). With the disc 100 across
// from the middle and a 22 hole for the label, each band is (100 - 22) / 4 = 19.5 thick:
//   band 0 (source) 80.5..100, band 1 61..80.5, band 2 41.5..61, band 3 (empty) 22..41.5.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  angleFor,
  angleOf,
  bandAt,
  bandRadii,
  groovePoints,
  layout,
  offsetAt,
  peaksOf,
} from "./geometry.ts";

const three = layout(3);

test("one band per stage plus the empty slot, thickness shared out evenly", () => {
  assert.equal(three.bands, 4);
  assert.equal(three.thickness, 19.5);
  assert.deepEqual(bandRadii(three, 0), { outer: 100, inner: 80.5, mid: 90.25 });
  assert.deepEqual(bandRadii(three, 3), { outer: 41.5, inner: 22, mid: 31.75 });
});

test("a twelve-stage chain has thirteen bands, 6 thick: the label list does the precise work", () => {
  const long = layout(12);
  assert.equal(long.bands, 13);
  assert.equal(long.thickness, 6);
});

test("a point's band is the one its radius falls in; the label and the outside are no band", () => {
  assert.equal(bandAt(three, 90, null), 0);
  assert.equal(bandAt(three, 70, null), 1);
  assert.equal(bandAt(three, 50, null), 2);
  assert.equal(bandAt(three, 30, null), 3);
  assert.equal(bandAt(three, 10, null), null, "inside the label");
  assert.equal(bandAt(three, 101, null), null, "outside the disc");
});

test("while dragging, the pointer may leave the disc and the band holds", () => {
  assert.equal(bandAt(three, 140, 0), 0);
  assert.equal(bandAt(three, 5, 3), 3);
});

test("snapping has hysteresis: a quarter of a band past the edge is needed to change band", () => {
  // The edge between band 0 and band 1 is at 80.5; a quarter band is 4.875.
  assert.equal(bandAt(three, 79, 0), 0, "1.5 past the edge: still band 0");
  assert.equal(bandAt(three, 75.7, 0), 0, "4.8 past the edge is not yet a quarter band");
  assert.equal(bandAt(three, 75, 0), 1, "5.5 past the edge: switches");
  assert.equal(bandAt(three, 82, 1), 1, "1.5 past the edge the other way: still band 1");
  assert.equal(bandAt(three, 86, 1), 0, "5.5 past: switches");
});

test("a pointer jittering across a band edge changes band at most once", () => {
  // Scripted path: starts in band 1, wobbles around the 80.5 edge, then settles well inside band 0.
  const path = [78, 81, 79.5, 82, 80, 83, 81, 79, 82.5, 80.6, 84, 86, 90];
  let band: number | null = 1;
  const seen: Array<number | null> = [band];
  for (const r of path) {
    band = bandAt(three, r, band);
    seen.push(band);
  }
  const changes = seen.filter((b, i) => i > 0 && b !== seen[i - 1]).length;
  assert.equal(changes, 1, `bands seen: ${seen.join(" ")}`);
  assert.equal(seen.at(-1), 0);
});

test("angles run clockwise from twelve o'clock", () => {
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-12;
  assert.ok(close(angleOf(0, -5), 0));
  assert.ok(close(angleOf(5, 0), Math.PI / 2));
  assert.ok(close(angleOf(0, 5), Math.PI));
  assert.ok(close(angleOf(-5, 0), (3 * Math.PI) / 2));
});

test("a turn of the groove is the whole stage: a quarter turn is a quarter of the length", () => {
  assert.equal(offsetAt(Math.PI / 2, 1.2), 0.3);
  assert.equal(offsetAt(Math.PI, 0.6), 0.3);
  assert.ok(Math.abs(angleFor(0.3, 1.2) - Math.PI / 2) < 1e-12);
  assert.equal(angleFor(5, 1.2), 2 * Math.PI, "past the end rests at the end");
  assert.equal(angleFor(-1, 1.2), 0);
  assert.equal(angleFor(1, 0), 0, "a stage of no length has nowhere to be");
});

test("peaks are the loudest sample in each slice, as a fraction of full scale", () => {
  const pcm = Int16Array.from([0, 16384, -32768, 0, 8192, -8192, 0, 0]);
  assert.deepEqual(peaksOf(pcm, 4), [0.5, 1, 0.25, 0]);
  assert.deepEqual(peaksOf(new Int16Array(0), 3), [0, 0, 0]);
});

test("a groove sits on its band's middle and wobbles outwards by the peak", () => {
  const flat = groovePoints(three, 1, [0, 0, 0, 0]);
  for (const [x, y] of flat) assert.ok(Math.abs(Math.hypot(x, y) - 70.75) < 1e-9);
  const peaked = groovePoints(three, 1, [1, 0, 0, 0]);
  // The first point is at twelve o'clock: straight up, pushed out by the wobble share of the band.
  const [x0, y0] = peaked[0]!;
  assert.ok(Math.abs(x0) < 1e-9);
  assert.ok(Math.abs(-y0 - (70.75 + 19.5 * 0.35)) < 1e-9, `y was ${y0}`);
});

test("the stylus pushes the groove under it outwards, most at its own angle and not at all far away", () => {
  const flat = groovePoints(three, 1, [0, 0, 0, 0]);
  // Pushed at twelve o'clock (angle 0), fully: the point there moves out by 0.3 of the band.
  const pushed = groovePoints(three, 1, [0, 0, 0, 0], { angle: 0, strength: 1 });
  assert.ok(Math.abs(Math.hypot(...pushed[0]!) - (70.75 + 19.5 * 0.3)) < 1e-9);
  // The point at six o'clock (index 2 of 4) is half a turn away: untouched.
  assert.deepEqual(pushed[2], flat[2]);
  // Half strength moves it half as far.
  const half = groovePoints(three, 1, [0, 0, 0, 0], { angle: 0, strength: 0.5 });
  assert.ok(Math.abs(Math.hypot(...half[0]!) - (70.75 + 19.5 * 0.15)) < 1e-9);
});
