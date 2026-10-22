/**
 * The Web Audio side. Nothing here touches `AudioContext` when this module is loaded: the context is
 * created lazily, inside the first user gesture, and never during render or at module scope (which
 * would crash server rendering and be blocked by browsers' autoplay rules).
 */
import { ATTACK, RELEASE, SAMPLE_RATE, stageGain } from "./config.ts";
import type { AudioGraph, Voice } from "./engine.ts";

// The slice of the Web Audio API this module uses, so it can be tested with a fake.
export interface ParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(value: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}
export interface NodeLike {
  connect(destination: unknown): unknown;
}
export interface GainLike extends NodeLike {
  gain: ParamLike;
}
export interface BufferLike {
  duration: number;
  copyToChannel(source: Float32Array, channel: number): void;
}
export interface SourceLike extends NodeLike {
  buffer: unknown;
  onended: (() => void) | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}
export interface AudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainLike;
  createBufferSource(): SourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
}
export type AudioContextConstructor = new (options?: { sampleRate?: number }) => AudioContextLike;

/**
 * Signed 16-bit samples to floats, exactly: `value / 32768`. Every int16 is exactly representable
 * as a float32, so what is heard is what is stored.
 */
export function pcmToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) / 32768;
  return out;
}

export interface CreatedContext {
  context: AudioContextLike;
  /** True when the browser could not give a 48 kHz context, so audio is resampled to its own rate. */
  resampled: boolean;
}

/**
 * A context at the canonical 48 kHz where the browser allows it. A browser that refuses the rate
 * (some mobile browsers do) gets its own default, and the 48 kHz buffers are resampled by the browser.
 */
export function createContext(Ctor: AudioContextConstructor): CreatedContext {
  try {
    const context = new Ctor({ sampleRate: SAMPLE_RATE });
    return { context, resampled: context.sampleRate !== SAMPLE_RATE };
  } catch {
    const context = new Ctor();
    return { context, resampled: context.sampleRate !== SAMPLE_RATE };
  }
}

/** The graph over a context and the stages' audio, as 48 kHz mono buffers. */
export class WebAudioGraph implements AudioGraph {
  readonly #context: AudioContextLike;
  readonly #buffers: BufferLike[];

  constructor(context: AudioContextLike, stages: readonly Int16Array[]) {
    this.#context = context;
    this.#buffers = stages.map((pcm) => {
      const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
      buffer.copyToChannel(pcmToFloat(pcm), 0);
      return buffer;
    });
  }

  voice(stage: number): Voice {
    const context = this.#context;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = this.#buffers[stage] ?? null;
    source.connect(gain);
    gain.connect(context.destination);
    const voice: Voice = {
      get onended() {
        return source.onended;
      },
      set onended(fn) {
        source.onended = fn;
      },
      start(offset, attack = ATTACK) {
        const now = context.currentTime;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(stageGain(stage), now + attack);
        source.start(now, offset);
      },
      stop(release = RELEASE) {
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, release / 4);
        try {
          source.stop(now + release);
        } catch {
          /* already stopped or never started */
        }
      },
    };
    return voice;
  }
}

/**
 * Creates the audio on first use. `unlock` must be called from a user gesture (a tap): browsers,
 * and iOS Safari in particular, keep a context suspended until `resume()` runs inside one. Audio
 * never starts without it.
 */
export class LazyAudio {
  readonly #ctor: () => AudioContextConstructor | undefined;
  readonly #stages: readonly Int16Array[];
  #created: (CreatedContext & { graph: WebAudioGraph }) | null = null;

  constructor(ctor: () => AudioContextConstructor | undefined, stages: readonly Int16Array[]) {
    this.#ctor = ctor;
    this.#stages = stages;
  }

  /** Whether a context exists yet. False until the first gesture. */
  get created(): boolean {
    return this.#created !== null;
  }

  /** Create the context if needed and resume it; call inside a user gesture. */
  async unlock(): Promise<WebAudioGraph> {
    if (this.#created === null) {
      const Ctor = this.#ctor();
      if (Ctor === undefined) throw new Error("this browser has no Web Audio");
      const created = createContext(Ctor);
      this.#created = { ...created, graph: new WebAudioGraph(created.context, this.#stages) };
    }
    if (this.#created.context.state !== "running") await this.#created.context.resume();
    return this.#created.graph;
  }

  get resampled(): boolean {
    return this.#created?.resampled ?? false;
  }

  get context(): AudioContextLike | null {
    return this.#created?.context ?? null;
  }
}
