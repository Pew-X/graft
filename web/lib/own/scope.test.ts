// The recording scope's arithmetic, worked by hand. It is an X-Y oscilloscope: the sound drives both axes,
// one microphone's signal against itself a moment earlier (a delay-coordinate plot). So a steady tone draws
// a perfect ellipse (a circle when the delay is a quarter of its period), louder sounds draw bigger loops,
// and speech draws tangled, living ones. The beam is dimmer where it moves fast, as on a real tube.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beamLevel, delayPairs, delaySamples, nextGain, readout } from "./scope.ts";

const sine = (hz: number, rate: number, n: number, amp = 0.5) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

test("the delay is about 1.25 ms: a quarter of the period of a 200 Hz voice", () => {
  assert.equal(delaySamples(48_000), 60);
  assert.equal(delaySamples(44_100), 55);
  assert.equal(delaySamples(48_000, 0.001), 1, "never less than one sample");
  assert.equal(delaySamples(0), 1);
});

test("a steady tone, delayed by a quarter of its period, draws a circle", () => {
  // 200 Hz at 48 kHz is 240 samples a cycle; a quarter of it is 60
  const pairs = delayPairs(sine(200, 48_000, 960), 60, 1);
  assert.equal(pairs.length, 960 - 60);
  for (const { x, y } of pairs)
    assert.ok(Math.abs(Math.hypot(x, y) - 0.5) < 1e-3, "radius stays 0.5");
});

test("at another delay the same tone draws an ellipse, and at none a straight line", () => {
  const tone = sine(200, 48_000, 960);
  const eighth = delayPairs(tone, 30, 1); // an eighth of the period: a thin ellipse
  const radii = eighth.map(({ x, y }) => Math.hypot(x, y));
  assert.ok(Math.max(...radii) - Math.min(...radii) > 0.1, "not a circle");
  const none = delayPairs(tone, 0, 1);
  for (const { x, y } of none)
    assert.ok(Math.abs(x - y) < 1e-9, "x equals y: a line at 45 degrees");
});

test("a louder sound draws bigger loops, in proportion", () => {
  const quiet = delayPairs(sine(200, 48_000, 960, 0.1), 60, 1);
  const loud = delayPairs(sine(200, 48_000, 960, 0.4), 60, 1);
  const radius = (p: { x: number; y: number }[]) =>
    Math.max(...p.map(({ x, y }) => Math.hypot(x, y)));
  assert.ok(Math.abs(radius(loud) / radius(quiet) - 4) < 1e-3);
});

test("the gain scales both axes alike and nothing leaves the screen", () => {
  const big = delayPairs(sine(200, 48_000, 960, 0.9), 60, 5);
  for (const { x, y } of big)
    assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, "clamped to the screen");
  assert.deepEqual(
    delayPairs(new Float32Array(10), 60, 1),
    [],
    "fewer samples than the delay: nothing",
  );
  assert.deepEqual(delayPairs(new Float32Array(0), 1, 1), []);
});

test("the beam is dimmer where it moves fast (a transient), brightest where it is slow, and never dark", () => {
  const slow = beamLevel(0.5);
  const medium = beamLevel(8);
  const fast = beamLevel(60);
  assert.ok(slow > medium && medium > fast, "monotonic in segment length");
  assert.ok(slow <= 1 && fast >= 0.2, "bounded: always visible, never over full");
  assert.ok(Math.abs(beamLevel(0) - 1) < 1e-9, "a beam that is not moving is full bright");
  assert.equal(beamLevel(Number.NaN), 1);
});

test("the gain follows the loudness: a loud peak is brought inside the screen at once, a quiet one opens gently", () => {
  const opened = nextGain(1, 0.02);
  assert.ok(opened > 1, "a quiet sound is opened up");
  const cut = nextGain(opened, 0.9);
  assert.ok(
    cut < opened && cut * 0.9 <= 0.51,
    "a loud peak is brought to about half the screen at once",
  );
  const after = nextGain(cut, 0.02);
  assert.ok(after > cut && after < 40, "opens gently");
  let g = 1;
  for (let i = 0; i < 4000; i++) g = nextGain(g, 0);
  assert.ok(g <= 40 + 1e-9, "capped, so room noise is not drawn as a roar");
});

test("the screen says what its two axes are, from the real delay", () => {
  assert.equal(readout(48_000), "x: mic now · y: mic 1.25 ms ago");
  assert.equal(readout(44_100), "x: mic now · y: mic 1.25 ms ago");
});
