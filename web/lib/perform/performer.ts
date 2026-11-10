/**
 * Performing the roll: the number keys and the pads play a stage's whole sound at once, from its start.
 * This is its own small path beside the playback engine, which keeps its one voice by design; nothing here
 * touches the engine's state machine. It is pure over a graph that makes voices, so every rule can be run
 * against a fake graph.
 *
 * Two rules for what happens when a press arrives while something sounds:
 *   cut    the new press releases whatever sounds, so a run of presses reads as a phrase (the default)
 *   layer  voices overlap, at most MOST_VOICES; a further press releases the oldest
 * A press on the pad that already sounds restarts it in either rule.
 */
import { ATTACK, RELEASE } from "../playback/config.ts";
import type { Voice } from "../playback/engine.ts";

/** The most voices that overlap in the overlap rule. */
export const MOST_VOICES = 6;
/** Release when a voice is stolen for a seventh: a little longer than a cut, so it is not heard as a click. */
export const STEAL_RELEASE = 0.03;

export type Rule = "single" | "overlap";

/** What the performer needs of the audio side. */
export interface PerformGraph {
  /** A voice for one stage, through the performance's mix bus. */
  voice(stage: number): Voice;
  /** How many voices sound now, so the bus can keep room for them. */
  voices(count: number): void;
}

export interface PerformerOptions {
  graph: PerformGraph;
  /** How many stages the chain has. */
  stages: number;
  /** Which stages sound now, oldest first, after every change. */
  onChange?: (sounding: readonly number[]) => void;
}

interface Live {
  stage: number;
  voice: Voice;
  /** When the voice began, in seconds on the caller's clock. */
  at: number;
}

export class Performer {
  readonly #graph: PerformGraph;
  readonly #stages: number;
  readonly #onChange: ((sounding: readonly number[]) => void) | undefined;
  #live: Live[] = [];
  #last: { stage: number; at: number } | null = null;
  #now: () => number;

  mode: Rule = "single";

  constructor(options: PerformerOptions & { now?: () => number }) {
    this.#graph = options.graph;
    this.#stages = options.stages;
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => performance.now() / 1000);
  }

  /** The stages that sound now, oldest first. */
  get sounding(): number[] {
    return this.#live.map((v) => v.stage);
  }

  /** The stage last pressed and when, even after its sound has ended. */
  get last(): { stage: number; at: number } | null {
    return this.#last;
  }

  /** Play a stage from its start. False when there is no such stage or the sound could not be made. */
  press(stage: number): boolean {
    if (!Number.isInteger(stage) || stage < 0 || stage >= this.#stages) return false;
    let voice: Voice;
    try {
      voice = this.#graph.voice(stage);
    } catch {
      return false;
    }
    // what makes room goes first, so the new voice never starts on top of a full house
    if (this.mode === "single") {
      for (const old of this.#live) old.voice.stop(RELEASE);
      this.#live = [];
    } else {
      const same = this.#live.find((v) => v.stage === stage);
      if (same) {
        same.voice.stop(RELEASE);
        this.#live = this.#live.filter((v) => v !== same);
      }
      while (this.#live.length >= MOST_VOICES) {
        this.#live.shift()?.voice.stop(STEAL_RELEASE);
      }
    }
    const at = this.#now();
    const entry: Live = { stage, voice, at };
    // a voice that ends by itself leaves the list; an old voice's late end must not remove a newer one
    voice.onended = () => {
      if (!this.#live.includes(entry)) return;
      this.#live = this.#live.filter((v) => v !== entry);
      this.#tell();
    };
    this.#live.push(entry);
    this.#last = { stage, at };
    try {
      voice.start(0, ATTACK);
    } catch {
      this.#live = this.#live.filter((v) => v !== entry);
      this.#tell();
      return false;
    }
    this.#tell();
    return true;
  }

  /** Forget the stage last pressed (perform was left): nothing is current any more. */
  reset(): void {
    this.#last = null;
  }

  /** Release everything that sounds. True when something did. */
  silence(): boolean {
    if (this.#live.length === 0) return false;
    for (const v of this.#live) v.voice.stop(RELEASE);
    this.#live = [];
    this.#tell();
    return true;
  }

  #tell(): void {
    this.#graph.voices(this.#live.length);
    this.#onChange?.(this.sounding);
  }
}
