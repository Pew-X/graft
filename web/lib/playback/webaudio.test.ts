import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ATTACK, RELEASE, SAMPLE_RATE } from "./config.ts";
import {
  LazyAudio,
  WebAudioGraph,
  createContext,
  pcmToFloat,
  type AudioContextConstructor,
  type AudioContextLike,
} from "./webaudio.ts";

/** A recording stand-in for the browser's AudioContext. */
class FakeContext implements AudioContextLike {
  static created: FakeContext[] = [];
  sampleRate: number;
  currentTime = 10;
  state = "suspended";
  destination = { name: "destination" };
  onstatechange: (() => void) | null = null;
  resumes = 0;
  calls: string[] = [];
  buffers: { length: number; sampleRate: number; channel0: Float32Array | null }[] = [];

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44_100;
    FakeContext.created.push(this);
  }

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  createGain() {
    const log = this.calls;
    return {
      connect: () => undefined,
      gain: {
        setValueAtTime: (v: number, t: number) => log.push(`gain=${v}@${t}`),
        linearRampToValueAtTime: (v: number, t: number) => log.push(`ramp=${v}@${t}`),
        setTargetAtTime: (v: number, t: number, k: number) => log.push(`target=${v}@${t}/${k}`),
        cancelScheduledValues: (t: number) => log.push(`cancel@${t}`),
      },
    };
  }
  createBufferSource() {
    const log = this.calls;
    let stopped = false;
    return {
      buffer: null as unknown,
      onended: null as (() => void) | null,
      connect: () => undefined,
      start: (when?: number, offset?: number) => log.push(`start@${when}+${offset}`),
      stop: (when?: number) => {
        if (stopped) throw new Error("InvalidStateError: already stopped");
        stopped = true;
        log.push(`stop@${when}`);
      },
    };
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const record = { length, sampleRate, channel0: null as Float32Array | null };
    this.buffers.push(record);
    return {
      duration: length / sampleRate,
      copyToChannel: (data: Float32Array) => {
        record.channel0 = data;
      },
    };
  }
}

/** A browser that refuses a 48 kHz context, as some mobile browsers do. */
class Refuses48k extends FakeContext {
  constructor(options?: { sampleRate?: number }) {
    if (options?.sampleRate !== undefined)
      throw new DOMException("sample rate not supported", "NotSupportedError");
    super(options);
  }
}

const asCtor = (c: unknown): AudioContextConstructor => c as AudioContextConstructor;

test("samples convert to floats as value / 32768, exactly, for every possible 16-bit value", () => {
  // Literal expectations: full scale negative is exactly -1, full scale positive just under 1.
  assert.deepEqual(
    [...pcmToFloat(Int16Array.of(-32768, -1, 0, 1, 16384, 32767))],
    [-1, -1 / 32768, 0, 1 / 32768, 0.5, 32767 / 32768],
  );
  fc.assert(
    fc.property(fc.integer({ min: -32768, max: 32767 }), (v) => {
      const out = pcmToFloat(Int16Array.of(v))[0] ?? Number.NaN;
      assert.equal(out * 32768, v, "float32 holds every int16 exactly, so nothing is lost");
    }),
    { numRuns: 2000 },
  );
});

test("no context exists until the first unlock, and unlocking again reuses it", async () => {
  FakeContext.created = [];
  const audio = new LazyAudio(() => asCtor(FakeContext), [Int16Array.of(1, 2, 3)]);
  assert.equal(audio.created, false);
  assert.equal(FakeContext.created.length, 0, "constructing the player must not create a context");
  await audio.unlock();
  assert.equal(FakeContext.created.length, 1);
  assert.equal(FakeContext.created[0]?.resumes, 1, "resume runs inside the gesture");
  await audio.unlock();
  assert.equal(FakeContext.created.length, 1);
  assert.equal(
    FakeContext.created[0]?.resumes,
    1,
    "an already running context is not resumed again",
  );
});

test("a browser with no Web Audio gives a clear error, not a crash at load", async () => {
  const audio = new LazyAudio(() => undefined, []);
  await assert.rejects(audio.unlock(), /no Web Audio/);
});

test("a 48 kHz context is requested; a browser that refuses it gets its own rate and the audio is resampled", () => {
  const honoured = createContext(asCtor(FakeContext));
  assert.equal(honoured.context.sampleRate, SAMPLE_RATE);
  assert.equal(honoured.resampled, false);
  const refused = createContext(asCtor(Refuses48k));
  assert.equal(refused.context.sampleRate, 44_100, "the fallback uses the browser's default rate");
  assert.equal(refused.resampled, true, "and says so, so the page can mention it");
});

test("the unsupported-rate path still builds the stages as 48 kHz buffers for the browser to resample", async () => {
  const audio = new LazyAudio(
    () => asCtor(Refuses48k),
    [Int16Array.of(100, -100), Int16Array.of(5)],
  );
  await audio.unlock();
  assert.equal(audio.resampled, true);
  const ctx = audio.context as FakeContext;
  assert.deepEqual(
    ctx.buffers.map((b) => [b.length, b.sampleRate]),
    [
      [2, SAMPLE_RATE],
      [1, SAMPLE_RATE],
    ],
  );
  assert.deepEqual([...(ctx.buffers[0]?.channel0 ?? [])], [100 / 32768, -100 / 32768]);
});

test("a voice fades in over the attack, starts at its offset, and fades out over the release", async () => {
  const audio = new LazyAudio(() => asCtor(FakeContext), [Int16Array.of(1, 2, 3, 4)]);
  const graph = await audio.unlock();
  const ctx = audio.context as FakeContext;
  ctx.calls.length = 0;
  const voice = graph.voice(0);
  voice.start(0.25, ATTACK);
  assert.deepEqual(ctx.calls, ["gain=0@10", `ramp=1@${10 + ATTACK}`, "start@10+0.25"]);
  ctx.calls.length = 0;
  voice.stop(RELEASE);
  assert.deepEqual(ctx.calls, ["cancel@10", `target=0@10/${RELEASE / 4}`, `stop@${10 + RELEASE}`]);
  assert.doesNotThrow(() => voice.stop(RELEASE), "releasing twice is harmless");
});

test("a voice's end callback is the source's own", async () => {
  const graph = new WebAudioGraph(new FakeContext(), [Int16Array.of(1)]);
  const voice = graph.voice(0);
  let ended = 0;
  voice.onended = () => {
    ended += 1;
  };
  voice.onended?.();
  assert.equal(ended, 1);
});
