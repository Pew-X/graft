/**
 * Fakes for tests: a clock that only moves when told to, and an audio graph that records what
 * sounded and when. Not used by the application.
 */
import type { AudioGraph, Clock, Voice } from "./engine.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  #now = 0;
  #next = 1;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, seconds: number): number {
    const id = this.#next++;
    this.#timers.push({ id, at: this.#now + Math.max(0, seconds), fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.#timers = this.#timers.filter((t) => t.id !== id);
  }

  /** Timers that have not fired and were not cancelled. */
  get pending(): number {
    return this.#timers.length;
  }

  /** Move time forward by `seconds`, running every timer that falls due, in order. */
  advance(seconds: number): void {
    const target = this.#now + seconds;
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t.id !== due.id);
      this.#now = due.at;
      due.fn();
    }
    this.#now = target;
  }
}

/** One sound as the fake graph saw it. */
export interface Sound {
  stage: number;
  /** When it started, in clock seconds. */
  startedAt: number;
  offset: number;
  attack: number;
  /** When it was released, if it was. */
  stoppedAt: number | null;
  release: number | null;
  /** True once it reached its end by itself. */
  ended: boolean;
}

/** Voices whose natural end is scheduled on the same fake clock. */
export class FakeGraph implements AudioGraph {
  readonly sounds: Sound[] = [];
  readonly #clock: FakeClock;
  readonly #lengths: readonly number[];

  constructor(clock: FakeClock, lengths: readonly number[]) {
    this.#clock = clock;
    this.#lengths = lengths;
  }

  voice(stage: number): Voice {
    const sound: Sound = {
      stage,
      startedAt: -1,
      offset: 0,
      attack: 0,
      stoppedAt: null,
      release: null,
      ended: false,
    };
    let timer: number | null = null;
    const voice: Voice = {
      onended: null,
      start: (offset, attack) => {
        sound.startedAt = this.#clock.now();
        sound.offset = offset;
        sound.attack = attack;
        this.sounds.push(sound);
        const remaining = Math.max(0, (this.#lengths[stage] ?? 0) - offset);
        timer = this.#clock.setTimeout(() => {
          timer = null;
          sound.ended = true;
          voice.onended?.();
        }, remaining);
      },
      stop: (release) => {
        if (timer !== null) this.#clock.clearTimeout(timer);
        timer = null;
        sound.stoppedAt = this.#clock.now();
        sound.release = release;
      },
    };
    return voice;
  }

  /** Sounds that have started and have neither ended nor been released: what is audible now. */
  get sounding(): Sound[] {
    return this.sounds.filter((s) => s.stoppedAt === null && !s.ended);
  }
}
