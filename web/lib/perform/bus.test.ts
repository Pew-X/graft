import assert from "node:assert/strict";
import { test } from "node:test";
import { KNEE, MixBus, headroom, softClip, type BusContext } from "./bus.ts";

test("one voice has all the room: the bus leaves it exactly as the roll plays it", () => {
  assert.equal(headroom(0), 1);
  assert.equal(headroom(1), 1);
});

test("more voices share the room, never growing louder than one", () => {
  let last = 1;
  for (let n = 2; n <= 12; n++) {
    const h = headroom(n);
    assert.ok(h < last, `${n} voices`);
    assert.ok(h > 0);
    last = h;
  }
  assert.ok(Math.abs(headroom(4) - 0.5) < 1e-12);
});

test("the soft clip is the identity up to the knee, so a single voice is not coloured", () => {
  const curve = softClip(KNEE, 4097);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    if (Math.abs(x) <= KNEE) assert.ok(Math.abs((curve[i] ?? 0) - x) < 1e-6, `x=${x}`);
  }
});

test("past the knee the curve only bends, stays odd-symmetric and never reaches full scale", () => {
  const curve = softClip(KNEE, 4097);
  let peak = 0;
  for (let i = 0; i < curve.length; i++) {
    const y = curve[i] ?? 0;
    peak = Math.max(peak, Math.abs(y));
    assert.ok(Math.abs(y) < 1, "inside full scale");
    // symmetric about the middle point
    assert.ok(Math.abs(y + (curve[curve.length - 1 - i] ?? 0)) < 1e-9);
    // rising: each point is at least the one before it
    if (i > 0) assert.ok(y >= (curve[i - 1] ?? 0) - 1e-12);
  }
  // full-scale input (a stage at the top of its range) costs under 0.5 dB
  assert.ok(20 * Math.log10(peak) > -0.5);
});

class Param {
  value = 1;
  readonly calls: Array<[string, ...number[]]> = [];
  setValueAtTime(value: number, time: number) {
    this.calls.push(["set", value, time]);
    this.value = value;
  }
  linearRampToValueAtTime() {}
  setTargetAtTime(value: number, time: number, constant: number) {
    this.calls.push(["target", value, time, constant]);
  }
  cancelScheduledValues(time: number) {
    this.calls.push(["cancel", time]);
  }
}

function context(now = 10): { context: BusContext; gain: Param; connected: unknown[] } {
  const gain = new Param();
  const connected: unknown[] = [];
  const shaper = {
    curve: null as Float32Array | null,
    oversample: "x",
    connect: (n: unknown) => connected.push(n),
  };
  const input = { gain, connect: (n: unknown) => connected.push(n) };
  return {
    gain,
    connected,
    context: {
      currentTime: now,
      destination: "speakers",
      createGain: () => input,
      createWaveShaper: () => shaper,
    },
  };
}

test("the bus runs the voices through headroom, then the soft clip, then the speakers", () => {
  const { context: ctx, connected } = context();
  const bus = new MixBus(ctx);
  assert.ok(bus.input);
  assert.equal(connected.length, 2);
  assert.equal(connected.at(-1), "speakers");
});

test("room is taken quickly when voices join and given back slowly when they go", () => {
  const { context: ctx, gain } = context();
  const bus = new MixBus(ctx);
  bus.voices(4);
  const down = gain.calls.find((c) => c[0] === "target");
  assert.equal(down?.[1], 0.5);
  gain.calls.length = 0;
  gain.value = 0.5;
  bus.voices(1);
  const up = gain.calls.find((c) => c[0] === "target");
  assert.equal(up?.[1], 1);
  assert.ok((up?.[3] ?? 0) > (down?.[3] ?? 1), "slower to rise than to fall");
  // the move starts from where the gain is now, not from a stale scheduled value
  assert.deepEqual(gain.calls.slice(0, 2), [
    ["cancel", 10],
    ["set", 0.5, 10],
  ]);
});
