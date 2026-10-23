// The painter against a recording stand-in for a canvas: what it draws, how much, and that every
// coordinate it produces is a real number on or near the screen. (How it looks is judged by eye.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { layout } from "./disc.ts";
import { paintGrooves, paintOverlay, type Scene } from "./paint.ts";

class Recorder {
  calls: Record<string, number> = {};
  points: Array<[number, number]> = [];
  transform = { rotate: 0 };
  [k: string]: unknown;
  constructor() {
    const count = (name: string) => () => {
      this.calls[name] = (this.calls[name] ?? 0) + 1;
    };
    for (const n of [
      "beginPath",
      "stroke",
      "fill",
      "arc",
      "save",
      "restore",
      "clip",
      "rect",
      "setLineDash",
      "fillText",
      "quadraticCurveTo",
      "translate",
    ]) {
      this[n] = count(n);
    }
    this["moveTo"] = (x: number, y: number) => {
      this.calls["moveTo"] = (this.calls["moveTo"] ?? 0) + 1;
      this.points.push([x, y]);
    };
    this["lineTo"] = (x: number, y: number) => {
      this.calls["lineTo"] = (this.calls["lineTo"] ?? 0) + 1;
      this.points.push([x, y]);
    };
    this["rotate"] = (a: number) => {
      this.calls["rotate"] = (this.calls["rotate"] ?? 0) + 1;
      this.transform.rotate += a;
    };
    this["createConicGradient"] = () => ({ addColorStop() {} });
  }
}
const ctx = () => new Recorder() as unknown as CanvasRenderingContext2D & Recorder;

const stage = (dye: string, cut: [number, number] | null = null) => ({
  dye,
  peaks: Array.from({ length: 96 }, (_, i) => 0.2 + 0.6 * Math.abs(Math.sin(i / 5))),
  cut,
});
const scene = (over: Partial<Scene> = {}): Scene => ({
  width: 1000,
  height: 600,
  theme: "dark",
  stages: [
    stage("#d2342a", [0.1, 0.6]),
    stage("#1e8c84", [0.2, 0.8]),
    stage("#e0a526"),
    stage("#c2307a"),
  ],
  active: 1,
  u: 0.4,
  rotation: 0.7,
  clock: 3,
  pointer: null,
  hover: null,
  reduced: false,
  ...over,
});

test("hairlines are stroked in a handful of grouped paths, not one stroke each", () => {
  const c = ctx();
  paintGrooves(c, scene());
  const l = layout(1000, 600, 4);
  const hairlines = 4 * Math.max(8, Math.round(l.slotW / 2.6));
  assert.ok(hairlines >= 60, "there are dozens of hairlines");
  assert.ok(
    (c.calls["stroke"] ?? 0) < hairlines / 3,
    `${c.calls["stroke"]} strokes for ${hairlines} hairlines`,
  );
});

test("every point it draws is a finite number within the disc's reach", () => {
  const c = ctx();
  const s = scene({ pointer: { x: 700, y: 300 } });
  paintGrooves(c, s);
  paintOverlay(c, s);
  const l = layout(1000, 600, 4);
  assert.ok(c.points.length > 2000);
  for (const [x, y] of c.points) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    // grooves are drawn about the centre (translated), the arm and stylus in screen space
    assert.ok(Math.abs(x) < 2 * l.R + 1100 && Math.abs(y) < 2 * l.R + 700, `${x},${y}`);
  }
});

test("reduced motion and the cached mode do not spin the disc; live mode does", () => {
  const live = ctx();
  paintGrooves(live, scene());
  assert.ok((live.calls["rotate"] ?? 0) >= 1 && live.transform.rotate > 0);
  for (const s of [scene({ reduced: true }), scene({ cached: true })]) {
    const c = ctx();
    paintGrooves(c, s);
    assert.equal(c.transform.rotate, 0);
  }
});

test("the groove under the stylus gives way in live mode and not in the cached mode", () => {
  const withPointer = { pointer: { x: 700, y: 300 } };
  const a = ctx();
  const b = ctx();
  paintGrooves(a, scene(withPointer));
  paintGrooves(b, scene({ ...withPointer, cached: true }));
  // Same hairlines, but pushed ones land on different points.
  assert.equal(a.points.length, b.points.length);
  assert.ok(
    a.points.some(
      ([x, y], i) => Math.abs(x - b.points[i]![0]) > 0.01 || Math.abs(y - b.points[i]![1]) > 0.01,
    ),
  );
});

test("the empty slot is drawn dashed, and the stage names appear only when hovering", () => {
  const c = ctx();
  paintGrooves(c, scene());
  assert.ok((c.calls["setLineDash"] ?? 0) >= 2, "dashed on, dashed off");
  const o = ctx();
  paintOverlay(o, scene());
  assert.equal(o.calls["fillText"] ?? 0, 0);
  const h = ctx();
  paintOverlay(
    h,
    scene({ pointer: { x: 700, y: 300 }, hover: { band: 1, name: "02 · up a fifth" } }),
  );
  assert.equal(h.calls["fillText"], 1);
});

test("twelve stages on a phone: still drawn, and still few strokes", () => {
  const c = ctx();
  const many = Array.from({ length: 12 }, (_, i) =>
    stage(["#d2342a", "#1e8c84", "#e0a526", "#c2307a"][i % 4]!),
  );
  paintGrooves(c, scene({ width: 390, height: 844, stages: many, active: 5 }));
  assert.ok((c.calls["stroke"] ?? 0) <= 12 * 6 + 8);
  for (const [x, y] of c.points) assert.ok(Number.isFinite(x) && Number.isFinite(y));
});
