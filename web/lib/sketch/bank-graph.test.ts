import assert from "node:assert/strict";
import { test } from "node:test";
import { BankGraph } from "./bank-graph.ts";
import type { AudioContextLike } from "../playback/webaudio.ts";
import type { MixBus } from "../perform/bus.ts";

function fake() {
  const buffers: number[] = [];
  const connected: unknown[] = [];
  const context = {
    sampleRate: 48_000,
    currentTime: 0,
    state: "running",
    destination: {},
    createBuffer: (_c: number, length: number) => {
      buffers.push(length);
      return { duration: length / 48_000, copyToChannel: () => undefined };
    },
    createGain: () => ({
      gain: {
        value: 1,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        setTargetAtTime: () => undefined,
        cancelScheduledValues: () => undefined,
      },
      connect: (to: unknown) => connected.push(to),
    }),
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    }),
  } as unknown as AudioContextLike;
  const bus = { input: { tag: "bus" }, voices: () => undefined } as unknown as MixBus;
  return { context, bus, buffers, connected };
}

test("a pad's float buffer is made on its first press, not when the pad is added, and only once", () => {
  const f = fake();
  const graph = new BankGraph(f.context, f.bus);
  graph.setPads([
    { id: "a", samples: new Int16Array(1000) },
    { id: "b", samples: new Int16Array(2000) },
  ]);
  assert.equal(f.buffers.length, 0, "twelve pads cost nothing until they are played");
  graph.voice(1);
  graph.voice(1);
  assert.deepEqual(f.buffers, [2000]);
  graph.voice(0);
  assert.deepEqual(f.buffers, [2000, 1000]);
});

test("a voice goes through the performance's bus, and a pad with no sound has no voice, loudly", () => {
  const f = fake();
  const graph = new BankGraph(f.context, f.bus);
  graph.setPads([
    { id: "a", samples: new Int16Array(10) },
    { id: "b", samples: null },
  ]);
  graph.voice(0);
  assert.ok(f.connected.includes(f.bus.input));
  assert.throws(() => graph.voice(1));
  assert.throws(() => graph.voice(7));
});

test("reordering keeps each pad's buffer with its sketch, and a sketch that left the bank gives its buffer back", () => {
  const f = fake();
  const graph = new BankGraph(f.context, f.bus);
  const a = { id: "a", samples: new Int16Array(1000) };
  const b = { id: "b", samples: new Int16Array(2000) };
  graph.setPads([a, b]);
  graph.voice(0);
  graph.setPads([b, a]); // swapped
  graph.voice(1); // a again: not made twice
  assert.equal(graph.made, 1);
  graph.setPads([b]);
  graph.setPads([a, b]);
  graph.voice(0);
  assert.equal(graph.made, 2, "a was made again after it left and came back");
});
