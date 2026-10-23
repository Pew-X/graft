/**
 * The playback engine: it feeds the state machine events and carries out its effects with an audio
 * graph and a clock that are passed in, so the whole choreography can be run against a fake clock
 * and a fake graph in tests and against Web Audio in the browser.
 *
 * What it adds to the machine is time. In roll mode it repeats the stage in focus with a gap and a
 * short attack until the step's dwell ends; in audition it plays the stage's whole output once. It
 * keeps at most two timers (the end of the step, and the next repeat) and at most one sounding voice,
 * and it ignores callbacks from voices that have already been replaced.
 */
import { ATTACK, REPEAT_GAP, RELEASE } from "./config.ts";
import { currentStage, idle, transition, type Effect, type Event, type State } from "./machine.ts";

/** A sound that can be started once and released once. */
export interface Voice {
  /** Begin sounding from `offsetSeconds` into the stage, fading in over `attack` seconds. */
  start(offsetSeconds: number, attack: number): void;
  /** Fade out over `release` seconds and stop. */
  stop(release: number): void;
  /** Called when the sound reaches its end by itself. Not called after `stop`. */
  onended: (() => void) | null;
}

/** Makes voices for stages. */
export interface AudioGraph {
  voice(stage: number): Voice;
}

/** Time, in seconds, and timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, seconds: number): number;
  clearTimeout(id: number): void;
}

export interface EngineOptions {
  graph: AudioGraph;
  clock: Clock;
  /** Length of each stage's full output, in seconds, source first. */
  lengths: readonly number[];
  /** Called after every change of state. */
  onChange?: (state: State) => void;
  /** Called when the audio graph throws; the engine has already gone back to a silent, idle state. */
  onError?: (error: unknown) => void;
}

interface Playing {
  voice: Voice;
  /** Which start this is; callbacks from an older start are stale and ignored. */
  generation: number;
}

export class Engine {
  readonly #graph: AudioGraph;
  readonly #clock: Clock;
  readonly #lengths: readonly number[];
  readonly #onChange: ((state: State) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  /** Events that arrived while another was being handled; they run in order afterwards. */
  readonly #queue: Event[] = [];
  #sending = false;

  #state: State = idle;
  #reducedMotion = false;
  #generation = 0;
  #playing: Playing | null = null;
  #dwellTimer: number | null = null;
  #repeatTimer: number | null = null;
  /** Where the current sound began: the stage, the offset into it and into the step, and when. */
  #origin: { mode: "roll" | "audition"; stage: number; offset: number; at: number } | null = null;

  constructor(options: EngineOptions) {
    if (options.lengths.length < 1) throw new RangeError("a chain has at least one stage");
    if (!options.lengths.every((n) => Number.isFinite(n) && n >= 0)) {
      throw new RangeError("every stage length must be a finite number of seconds, zero or more");
    }
    this.#graph = options.graph;
    this.#clock = options.clock;
    this.#lengths = options.lengths;
    this.#onChange = options.onChange;
    this.#onError = options.onError;
  }

  get state(): State {
    return this.#state;
  }

  get reducedMotion(): boolean {
    return this.#reducedMotion;
  }

  /** The stage the engine says is current; the sound that is playing is always this one. */
  get currentStage(): number | null {
    return currentStage(this.#state, this.#lengths.length);
  }

  /**
   * Seconds into the current stage's output, for the stylus to ride: where the sound is, where it
   * stopped if paused, the end of the groove in the gap between two repeats or after an audition
   * ended. Null when nothing is current.
   */
  get stagePosition(): number | null {
    const stage = this.currentStage;
    if (stage === null) return null;
    const length = this.#lengths[stage] ?? 0;
    const state = this.#state;
    const within = (elapsed: number): number => {
      const cycle = length + REPEAT_GAP;
      return Math.min(cycle > 0 ? elapsed % cycle : 0, length);
    };
    switch (state.kind) {
      case "rolling":
        return within(this.#position());
      case "auditioning":
        return state.ended ? length : this.#position();
      case "paused":
        return state.from.kind === "rolling"
          ? within(state.from.elapsed)
          : Math.min(state.from.offset, length);
      default:
        return null;
    }
  }

  /** The main play control. */
  play(): void {
    this.#send({ type: "play" });
  }

  /** Pause, freezing the position. */
  pause(): void {
    this.#send({ type: "pause", position: this.#position() });
  }

  /** Tap a stage's label or band: audition it, pause it if it is the one playing, replay it if it ended. */
  tapStage(stage: number): void {
    const sameAudition = this.#state.kind === "auditioning" && this.#state.stage === stage;
    this.#send({ type: "tapStage", stage, position: sameAudition ? this.#position() : 0 });
  }

  scrubStart(stage: number, offsetSeconds: number): void {
    this.#send({ type: "scrubStart", stage, offset: offsetSeconds });
  }

  scrubMove(stage: number, offsetSeconds: number): void {
    this.#send({ type: "scrubMove", stage, offset: offsetSeconds });
  }

  scrubEnd(): void {
    this.#send({ type: "scrubEnd" });
  }

  next(): void {
    this.#send({ type: "next" });
  }

  previous(): void {
    this.#send({ type: "previous" });
  }

  /** The page went to the background, or the output device went away: pause cleanly. */
  tabHidden(): void {
    this.#send({ type: "tabHidden", position: this.#position() });
  }

  /** The route changed away from the player: stop everything. */
  routeChange(): void {
    this.#send({ type: "routeChange" });
  }

  setReducedMotion(enabled: boolean): void {
    this.#reducedMotion = enabled;
    this.#send({ type: "reducedMotion", enabled });
  }

  /** How many timers the engine holds right now. At most two. */
  get timers(): number {
    return (this.#dwellTimer === null ? 0 : 1) + (this.#repeatTimer === null ? 0 : 1);
  }

  /** How many voices are sounding or fading in right now. At most one. */
  get voices(): number {
    return this.#playing === null ? 0 : 1;
  }

  /** Seconds into the current step (roll) or into the stage (audition). */
  #position(): number {
    const origin = this.#origin;
    if (origin === null) return 0;
    const elapsed = origin.offset + (this.#clock.now() - origin.at);
    return origin.mode === "audition"
      ? Math.min(elapsed, this.#lengths[origin.stage] ?? elapsed)
      : elapsed;
  }

  #send(event: Event): void {
    // An event raised while another is being handled (a voice that ends at once, say) waits its turn,
    // so listeners always see states in order and a nested event never runs on half-applied state.
    this.#queue.push(event);
    if (this.#sending) return;
    this.#sending = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        this.#handle(next);
      }
    } finally {
      this.#sending = false;
    }
  }

  #handle(event: Event): void {
    const { state, effects } = transition(this.#state, event, this.#lengths.length);
    this.#state = state;
    try {
      for (const effect of effects) this.#run(effect);
    } catch (error) {
      // The audio graph failed part way through. State and sound must not disagree, so go silent and
      // idle, discard anything queued, and say what happened.
      this.#queue.length = 0;
      this.#stopVoice();
      this.#clearRepeat();
      this.#clearDwell();
      this.#origin = null;
      this.#state = idle;
      this.#onChange?.(this.#state);
      this.#onError?.(error);
      return;
    }
    this.#onChange?.(state);
  }

  #run(effect: Effect): void {
    switch (effect.type) {
      case "stop":
        this.#stopVoice();
        this.#clearRepeat();
        this.#origin = null;
        break;
      case "start":
        this.#start(effect.stage, effect.offset, effect.mode);
        break;
      case "dwell":
        this.#clearDwell();
        this.#dwellTimer = this.#clock.setTimeout(() => {
          this.#dwellTimer = null;
          this.#send({ type: "dwellEnded" });
        }, effect.seconds);
        break;
      case "cancelDwell":
        this.#clearDwell();
        break;
    }
  }

  #start(stage: number, offset: number, mode: "roll" | "audition"): void {
    this.#generation += 1;
    this.#origin = { mode, stage, offset, at: this.#clock.now() };
    const length = this.#lengths[stage] ?? 0;
    if (mode === "audition") {
      // The whole output, once, from the chosen offset; no repeats. A stage resumed at (or within a few
      // milliseconds of) its end would make no sound, so it plays again from the start.
      const from = offset >= length - 0.005 ? 0 : offset;
      this.#origin = { mode, stage, offset: from, at: this.#clock.now() };
      this.#playVoice(stage, from, () => this.#send({ type: "auditionEnded" }));
      return;
    }
    // Roll: the stage repeats with a gap; `offset` is how far into the step this is, so a resumed
    // step picks up at the same point of the same repeat.
    const cycle = length + REPEAT_GAP;
    const within = cycle > 0 ? offset % cycle : 0;
    if (within < length) {
      this.#playRepeat(stage, within);
    } else {
      this.#scheduleRepeat(stage, cycle - within); // resumed in the silence between two repeats
    }
  }

  #playRepeat(stage: number, from: number): void {
    const generation = this.#generation;
    this.#playVoice(stage, from, () => {
      if (generation !== this.#generation) return;
      this.#playing = null;
      this.#scheduleRepeat(stage, REPEAT_GAP);
    });
  }

  #scheduleRepeat(stage: number, afterSeconds: number): void {
    const generation = this.#generation;
    this.#clearRepeat();
    this.#repeatTimer = this.#clock.setTimeout(() => {
      this.#repeatTimer = null;
      if (generation === this.#generation) this.#playRepeat(stage, 0);
    }, afterSeconds);
  }

  #playVoice(stage: number, offset: number, onEnd: () => void): void {
    const voice = this.#graph.voice(stage);
    const generation = this.#generation;
    voice.onended = () => {
      // A voice that was replaced or released must not move the machine.
      if (this.#playing?.voice === voice && generation === this.#generation) {
        this.#playing = null;
        onEnd();
      }
    };
    this.#playing = { voice, generation };
    voice.start(offset, ATTACK);
  }

  #stopVoice(): void {
    const playing = this.#playing;
    this.#playing = null;
    if (playing !== null) {
      playing.voice.onended = null;
      playing.voice.stop(RELEASE);
    }
  }

  #clearDwell(): void {
    if (this.#dwellTimer !== null) this.#clock.clearTimeout(this.#dwellTimer);
    this.#dwellTimer = null;
  }

  #clearRepeat(): void {
    if (this.#repeatTimer !== null) this.#clock.clearTimeout(this.#repeatTimer);
    this.#repeatTimer = null;
  }
}
