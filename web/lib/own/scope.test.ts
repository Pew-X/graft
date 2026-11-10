// The recording scope's arithmetic, worked by hand. It is an X-Y oscilloscope: the sound drives both axes,
// one microphone's signal against itself a moment earlier (a delay-coordinate plot). The delay follows the
// sound: the first zero of its autocorrelation, which for a steady tone is a quarter of its period, so the
// tone draws a circle, and for a voice moves as the pitch does. Loudness maps to the size of the figure
// through a slow reference, so a whisper is small and a shout is large. The beam is dimmer where it moves
// fast, as on a real tube.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beamLevel,
  delayPairs,
  delaySamples,
  gainFor,
  nextReference,
  slewDelay,
  tunedDelay,
} from "./scope.ts";

const sine = (hz: number, rate: number, n: number, amp = 0.5) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

test("the default delay is about 1.25 ms: a quarter of the period of a 200 Hz voice", () => {
  assert.equal(delaySamples(48_000), 60);
  assert.equal(delaySamples(44_100), 55);
  assert.equal(delaySamples(48_000, 0.001), 1, "never less than one sample");
  assert.equal(delaySamples(0), 1);
});

test("a steady tone, delayed by a quarter of its period, draws a circle", () => {
  const pairs = delayPairs(sine(200, 48_000, 960), 60, 1);
  assert.equal(pairs.length, 960 - 60);
  for (const { x, y } of pairs)
    assert.ok(Math.abs(Math.hypot(x, y) - 0.5) < 1e-3, "radius stays 0.5");
});

test("at another delay the same tone draws an ellipse, and at none a straight line", () => {
  const tone = sine(200, 48_000, 960);
  const radii = delayPairs(tone, 30, 1).map(({ x, y }) => Math.hypot(x, y));
  assert.ok(Math.max(...radii) - Math.min(...radii) > 0.1, "not a circle");
  for (const { x, y } of delayPairs(tone, 0, 1))
    assert.ok(Math.abs(x - y) < 1e-9, "a line at 45 degrees");
});

test("the delay is found from the sound: the first zero of its autocorrelation, a quarter of a tone's period", () => {
  // 200 Hz at 48 kHz: period 240 samples, a quarter is 60; 100 Hz: 120; 400 Hz: 30
  for (const [hz, quarter] of [
    [200, 60],
    [100, 120],
    [400, 30],
    [150, 80],
  ] as const) {
    // the analyser's whole window: 2048 samples, five or more cycles of anything above 100 Hz
    const found = tunedDelay(sine(hz, 48_000, 2048), 48_000);
    assert.ok(
      found !== null && Math.abs(found - quarter) <= 1.5,
      `${hz} Hz: ${found} vs ${quarter}`,
    );
  }
});

test("found from the sound, the delay makes that tone's figure a circle whatever its pitch", () => {
  for (const hz of [110, 180, 260, 330]) {
    const tone = sine(hz, 48_000, 1200);
    const delay = Math.round(tunedDelay(tone, 48_000)!);
    const radii = delayPairs(tone, delay, 1).map(({ x, y }) => Math.hypot(x, y));
    const spread = (Math.max(...radii) - Math.min(...radii)) / 0.5;
    assert.ok(spread < 0.08, `${hz} Hz: radius varies by ${(spread * 100).toFixed(1)}%`);
  }
});

test("a sound with no clear period, or no sound, gives no delay (the caller keeps what it had)", () => {
  assert.equal(tunedDelay(new Float32Array(1024), 48_000), null, "silence");
  const noise = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i * i * 12.9898) * 0.3);
  const found = tunedDelay(noise, 48_000);
  assert.ok(found === null || (found >= 6 && found <= 288), "noise: none, or a small sensible one");
  assert.equal(tunedDelay(new Float32Array(10), 48_000), null, "too short to say");
});

test("the delay glides to a new pitch and does not jump", () => {
  assert.equal(slewDelay(60, 60), 60);
  assert.ok(slewDelay(60, 120) > 60 && slewDelay(60, 120) <= 63, "up, a few samples at most");
  assert.ok(slewDelay(60, 30) < 60 && slewDelay(60, 30) >= 57, "down, a few samples at most");
  assert.equal(slewDelay(60, 61), 61, "close enough: it arrives");
  let d = 60;
  for (let i = 0; i < 100; i++) d = slewDelay(d, 120);
  assert.equal(d, 120, "and it does arrive");
});

test("a louder sound draws bigger loops, in proportion", () => {
  const quiet = delayPairs(sine(200, 48_000, 960, 0.1), 60, 1);
  const loud = delayPairs(sine(200, 48_000, 960, 0.4), 60, 1);
  const radius = (p: { x: number; y: number }[]) =>
    Math.max(...p.map(({ x, y }) => Math.hypot(x, y)));
  assert.ok(Math.abs(radius(loud) / radius(quiet) - 4) < 1e-3);
});

test("the gain scales both axes alike and nothing leaves the screen", () => {
  for (const { x, y } of delayPairs(sine(200, 48_000, 960, 0.9), 60, 5))
    assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, "clamped to the screen");
  assert.deepEqual(
    delayPairs(new Float32Array(10), 60, 1),
    [],
    "fewer samples than the delay: nothing",
  );
});

test("the beam is dimmer where it moves fast (a transient), brightest where it is slow, and never dark", () => {
  assert.ok(beamLevel(0.5) > beamLevel(8) && beamLevel(8) > beamLevel(60));
  assert.ok(beamLevel(0.5) <= 1 && beamLevel(60) >= 0.2);
  assert.ok(Math.abs(beamLevel(0) - 1) < 1e-9);
  assert.equal(beamLevel(Number.NaN), 1);
});

test("loudness maps to size: the figure is about half the screen at the sound's usual level, smaller when quieter, bigger when it swells", () => {
  // settle a reference on a steady level
  let ref = 0.05;
  for (let i = 0; i < 400; i++) ref = nextReference(ref, 0.3);
  const usual = 0.3 * gainFor(ref);
  assert.ok(
    Math.abs(usual - 0.5) < 0.03,
    `usual level draws at ${usual.toFixed(2)} of the half-width`,
  );
  const whisper = 0.06 * gainFor(ref);
  assert.ok(whisper < usual / 3, "a whisper is small");
  const swell = 0.6 * gainFor(nextReference(ref, 0.6));
  assert.ok(swell > usual && swell <= 0.95, "a swell is bigger, and still on the screen");
});

test("the reference follows loud sounds quickly and quiet ones slowly, and has a floor so the room's hiss is not blown up", () => {
  const up = nextReference(0.1, 0.5);
  assert.ok(up > 0.1 && up < 0.5, "moves toward a louder sound at once, not all the way");
  const down = nextReference(0.5, 0.01);
  assert.ok(down < 0.5 && down > 0.49, "eases down over seconds, not frames");
  let ref = 0.3;
  for (let i = 0; i < 20000; i++) ref = nextReference(ref, 0);
  assert.ok(ref >= 0.01 - 1e-12 && ref < 0.02, "silence settles at a floor");
  assert.ok(gainFor(ref) <= 50, "so the gain is bounded");
});

test("one loud pop does not blind the scope: the figure is still there at once and the memory forgets it in a couple of seconds", () => {
  // a steady voice, then a single frame of a pop ten times as loud
  let ref = 0.1;
  for (let i = 0; i < 400; i++) ref = nextReference(ref, 0.1);
  const popped = nextReference(ref, 1);
  const size = 0.1 * gainFor(popped);
  assert.ok(
    size > 0.3,
    `the voice is still drawn at ${size.toFixed(2)} of the half-width just after the pop`,
  );
  // and a couple of seconds on (about 120 frames) the voice is back to its usual size
  let r = popped;
  for (let i = 0; i < 150; i++) r = nextReference(r, 0.1);
  assert.ok(0.1 * gainFor(r) > 0.4, "back to about its usual size within a few seconds");
});

test("a memory that starts high, as a device's opening blip leaves it, forgets it within seconds", () => {
  let ref = 1;
  for (let i = 0; i < 300; i++) ref = nextReference(ref, 0.05); // five seconds at 60 frames a second
  assert.ok(ref < 0.2, `after five seconds the memory is ${ref.toFixed(2)}`);
});
