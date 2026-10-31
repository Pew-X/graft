// The preview loops the exact bytes that would be sent, and replacing it never leaves two playing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Previewer, type PreviewContext } from "./preview.ts";

function fake() {
  const log: string[] = [];
  const sources: Array<{ loop: boolean; stopped: boolean; buffer: unknown }> = [];
  const created: Array<{ sampleRate?: number } | undefined> = [];
  const context: PreviewContext = {
    sampleRate: 48_000,
    currentTime: 0,
    state: "suspended",
    destination: {},
    resume: async () => {
      log.push("resume");
      (context as { state: string }).state = "running";
    },
    createGain: () => ({
      connect: () => undefined,
      gain: {
        value: 1,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        setTargetAtTime: () => undefined,
        cancelScheduledValues: () => undefined,
      },
    }),
    createBuffer: (_c, length) => ({
      duration: length / 48_000,
      length,
      copyToChannel: (data: Float32Array) => log.push(`copy:${data.length}:${data[0]}:${data[1]}`),
    }),
    createBufferSource: () => {
      const s = {
        loop: false,
        stopped: false,
        buffer: null as unknown,
        connect: () => undefined,
        start: () => log.push("start"),
        stop: () => {
          s.stopped = true;
          log.push("stop");
        },
        onended: null,
      };
      sources.push(s);
      return s;
    },
  };
  const Ctor = function (options?: { sampleRate?: number }) {
    created.push(options);
    return context;
  } as unknown as new (options?: { sampleRate?: number }) => PreviewContext;
  return { Ctor, context, log, sources, created };
}

test("nothing is created until play: no audio context exists before a gesture", () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  assert.equal(f.created.length, 0);
  assert.equal(p.playing, false);
});

test("play creates a 48 kHz context, resumes it, and loops the samples as exact value over 32768", async () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  await p.play(Int16Array.of(16_384, -32_768, 0));
  assert.deepEqual(f.created, [{ sampleRate: 48_000 }]);
  assert.ok(f.log.includes("resume"));
  assert.ok(f.log.includes("copy:3:0.5:-1"), f.log.join(" "));
  assert.equal(f.sources[0]?.loop, true);
  assert.equal(p.playing, true);
});

test("playing again replaces the loop: the first is stopped, only one is ever audible", async () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  await p.play(Int16Array.of(1, 2, 3));
  await p.play(Int16Array.of(4, 5, 6));
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources[0]?.stopped, true);
  assert.equal(f.sources[1]?.stopped, false);
});

test("stop ends the loop and reports not playing; stopping twice is harmless", async () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  await p.play(Int16Array.of(1, 2, 3));
  p.stop();
  p.stop();
  assert.equal(p.playing, false);
  assert.equal(f.sources[0]?.stopped, true);
});

test("a browser with no Web Audio says so instead of throwing from inside a gesture", async () => {
  const p = new Previewer(() => undefined);
  await assert.rejects(() => p.play(Int16Array.of(1)), /no Web Audio/);
});

test("unlock makes and resumes the context once, inside the gesture, and play reuses it", async () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  await p.unlock();
  await p.unlock();
  assert.equal(f.created.length, 1);
  assert.equal(f.log.filter((l) => l === "resume").length, 1);
  await p.play(Int16Array.of(1, 2, 3));
  assert.equal(f.created.length, 1, "no second context");
});

test("a stop that comes while the context is still waking is honoured: the loop never starts", async () => {
  const f = fake();
  let wake: () => void = () => undefined;
  f.context.resume = () =>
    new Promise<void>((resolve) => {
      wake = () => {
        (f.context as { state: string }).state = "running";
        resolve();
      };
    });
  const p = new Previewer(() => f.Ctor);
  const playing = p.play(Int16Array.of(1, 2, 3));
  p.stop(); // the maker pressed pause before the audio woke
  wake();
  await playing;
  assert.equal(f.sources.length, 0, "no source was ever started");
  assert.equal(p.playing, false);
});

test("closing the previewer stops the loop and closes its audio context, once", async () => {
  const f = fake();
  let closed = 0;
  (f.context as unknown as { close: () => Promise<void> }).close = async () => void (closed += 1);
  const p = new Previewer(() => f.Ctor);
  await p.play(Int16Array.of(1, 2, 3));
  p.close();
  p.close();
  assert.equal(p.playing, false);
  assert.equal(f.sources[0]?.stopped, true);
  assert.equal(closed, 1);
});

test("playOnce plays from the start without looping, ends when the sound ends, and a stop ends it at once", async () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  const first = p.playOnce(Int16Array.of(1, 2, 3));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.sources.at(-1)?.loop, false);
  // the sound ends by itself
  (f.sources.at(-1) as unknown as { onended: () => void }).onended();
  await first;
  // a second one is stopped by stop(): the wait ends without waiting for the sound
  const second = p.playOnce(Int16Array.of(4, 5, 6));
  await new Promise((r) => setTimeout(r, 5));
  p.stop();
  await second;
  assert.equal(p.playing, false);
});

test("playing one sound once while a loop plays replaces the loop: only one is ever audible", async () => {
  const f = fake();
  const p = new Previewer(() => f.Ctor);
  await p.play(Int16Array.of(1, 2));
  const once = p.playOnce(Int16Array.of(3, 4));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.sources[0]?.stopped, true, "the loop was stopped");
  p.stop();
  await once;
});
