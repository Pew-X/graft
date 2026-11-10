/**
 * The loop the maker hears while moving a control: the rendered bytes, played again and again. The
 * audio context is made on the first play, which is always inside a gesture (a drag, a key or a tap),
 * never at load. Samples go to floats exactly (value over 32768), so what is heard is what is stored.
 */
import { RELEASE, SAMPLE_RATE } from "../playback/config.ts";
import { pcmToFloat } from "../playback/webaudio.ts";
import { loopFraction } from "./playhead.ts";

interface ParamLike {
  readonly value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(value: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}
export interface PreviewContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close?(): Promise<void>;
  createGain(): { gain: ParamLike; connect(d: unknown): unknown };
  createBuffer(
    channels: number,
    length: number,
    rate: number,
  ): { duration: number; copyToChannel(data: Float32Array, channel: number): void };
  createBufferSource(): {
    buffer: unknown;
    loop: boolean;
    onended: (() => void) | null;
    connect(d: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
}
type Ctor = new (options?: { sampleRate?: number }) => PreviewContext;

export class Previewer {
  readonly #ctor: () => Ctor | undefined;
  #context: PreviewContext | null = null;
  #stopLoop: (() => void) | null = null;
  /** When the loop now playing began (the context's clock) and how long it is, for the playhead. */
  #loop: { began: number; seconds: number } | null = null;
  /** Bumped by every stop, so a play that was waiting on the context can tell it was cancelled. */
  #generation = 0;

  constructor(ctor: () => Ctor | undefined) {
    this.#ctor = ctor;
  }

  get playing(): boolean {
    return this.#stopLoop !== null;
  }

  /** How far through the loop now playing the sound is (0 up to 1), or null when no loop is playing. */
  fraction(): number | null {
    const loop = this.#loop;
    if (loop === null || this.#context === null || this.#stopLoop === null) return null;
    return loopFraction(this.#context.currentTime - loop.began, loop.seconds);
  }

  /**
   * Make the audio context and resume it. Call inside a user gesture, before the first sound is
   * ready: browsers (iOS Safari first) keep a context suspended unless `resume` ran inside one.
   */
  async unlock(): Promise<PreviewContext> {
    if (this.#context === null) {
      const Context = this.#ctor();
      if (Context === undefined) throw new Error("this browser has no Web Audio");
      try {
        this.#context = new Context({ sampleRate: SAMPLE_RATE });
      } catch {
        this.#context = new Context();
      }
    }
    if (this.#context.state !== "running") await this.#context.resume();
    return this.#context;
  }

  /** Loop `samples`, replacing whatever was looping. */
  async play(samples: Int16Array): Promise<void> {
    const wanted = this.#generation;
    const context = await this.unlock();
    if (wanted !== this.#generation) return; // stopped while the audio was waking
    this.stop();
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(pcmToFloat(samples), 0);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    this.#loop = { began: context.currentTime, seconds: samples.length / SAMPLE_RATE };
    this.#stopLoop = () => {
      const now = context.currentTime;
      const level = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(level, now);
      gain.gain.setTargetAtTime(0, now, RELEASE / 4);
      try {
        source.stop(now + RELEASE);
      } catch {
        /* already stopped */
      }
    };
  }

  /**
   * Play `samples` once, from the start, replacing whatever was playing, and resolve when it ends or is
   * stopped. Used to hear one sketch after another; the loop above is for moving a control.
   */
  async playOnce(samples: Int16Array): Promise<void> {
    const wanted = this.#generation;
    const context = await this.unlock();
    if (wanted !== this.#generation) return;
    this.stop();
    const wantedNow = this.#generation;
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(pcmToFloat(samples), 0);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = false;
    source.connect(gain);
    gain.connect(context.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      this.#stopLoop = () => {
        const now = context.currentTime;
        const level = gain.gain.value;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(level, now);
        gain.gain.setTargetAtTime(0, now, RELEASE / 4);
        try {
          source.stop(now + RELEASE);
        } catch {
          /* already stopped */
        }
        resolve();
      };
      source.start();
    });
    if (this.#generation === wantedNow) this.#stopLoop = null;
  }

  stop(): void {
    this.#generation += 1;
    this.#stopLoop?.();
    this.#stopLoop = null;
    this.#loop = null;
  }

  /** Stop, and give the audio context back: browsers allow only a few. */
  close(): void {
    this.stop();
    const context = this.#context;
    this.#context = null;
    void context?.close?.().catch(() => undefined);
  }
}
