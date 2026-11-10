/**
 * A phrase: the presses made while performing, kept as a list of which pad and when. It carries no sound and
 * no identity, only stage numbers and times, and it lives nowhere but in the page's own address fragment
 * (`#phrase=1:0,3:35,12:120`: stage, then hundredths of a second since the first press), so a link is the
 * whole of it. The address comes from outside, so the parser is strict and bounded: anything that is not
 * exactly what `encodePhrase` writes is no phrase. There is no grid, tempo or editing here, by design.
 */

/** The most presses a phrase holds. */
export const MOST_PRESSES = 64;
/** The longest a phrase runs, in hundredths of a second (16 seconds). */
export const MOST_UNITS = 1600;
/** The stages the number keys reach, and so the most a phrase can name. */
const MOST_STAGE = 12;
/** The rest a looped phrase leaves after its last press before it starts over, in seconds. */
const REST = 0.5;

/** One press: the stage (counted from 0) and when, in hundredths of a second from the first press. */
export interface Press {
  stage: number;
  at: number;
}
export type Phrase = readonly Press[];

const FRAGMENT = "#phrase=";
/** A hard ceiling on what is even looked at, long before the patterns run. */
const LONGEST_FRAGMENT = 2048;

/** The address fragment for a phrase, or null when it is empty, too long, or names a stage no key reaches. */
export function encodePhrase(phrase: Phrase): string | null {
  if (phrase.length === 0 || phrase.length > MOST_PRESSES) return null;
  const first = phrase[0]?.at ?? 0;
  const parts: string[] = [];
  let before = 0;
  for (const { stage, at } of phrase) {
    const t = at - first;
    if (!Number.isInteger(stage) || stage < 0 || stage >= MOST_STAGE) return null;
    if (!Number.isInteger(t) || t < before || t > MOST_UNITS) return null;
    parts.push(`${stage + 1}:${t}`);
    before = t;
  }
  return `${FRAGMENT}${parts.join(",")}`;
}

const ITEM = /^(1[0-2]|[1-9]):(0|[1-9]\d{0,3})$/;

/**
 * A phrase read back from an address fragment, or null for anything that is not exactly what `encodePhrase`
 * writes: too many presses, a time that goes backwards or past sixteen seconds, a first press that is not at
 * zero, a stage past twelve or past this chain's stages. A link with one bad press is no phrase at all.
 */
export function parsePhraseHash(hash: string, stages: number): Phrase | null {
  if (hash.length > LONGEST_FRAGMENT || !hash.startsWith(FRAGMENT)) return null;
  const items = hash.slice(FRAGMENT.length).split(",");
  if (items.length === 0 || items.length > MOST_PRESSES) return null;
  const phrase: Press[] = [];
  let before = 0;
  for (const item of items) {
    const found = ITEM.exec(item);
    if (!found) return null;
    const stage = Number(found[1]) - 1;
    const at = Number(found[2]);
    if (stage >= stages || at < before || at > MOST_UNITS) return null;
    if (phrase.length === 0 && at !== 0) return null;
    phrase.push({ stage, at });
    before = at;
  }
  return phrase;
}

/** Records presses against a clock in seconds. The first press is time zero. */
export class PhraseRecorder {
  readonly #now: () => number;
  #presses: Press[] = [];
  #began = 0;
  #active = false;
  #full = false;

  constructor(now: () => number) {
    this.#now = now;
  }

  get active(): boolean {
    return this.#active;
  }

  /** The phrase has reached its limit of presses or seconds: further presses are not kept. */
  get full(): boolean {
    return this.#full;
  }

  get count(): number {
    return this.#presses.length;
  }

  start(): void {
    this.#presses = [];
    this.#full = false;
    this.#active = true;
  }

  /** Keep a press. False when not recording or when the phrase is full. */
  note(stage: number): boolean {
    if (!this.#active || this.#full) return false;
    if (this.#presses.length >= MOST_PRESSES) {
      this.#full = true;
      return false;
    }
    const now = this.#now();
    if (this.#presses.length === 0) this.#began = now;
    const at = Math.round((now - this.#began) * 100);
    if (at > MOST_UNITS) {
      this.#full = true;
      return false;
    }
    this.#presses.push({ stage, at });
    return true;
  }

  /** End recording and hand back what was kept (empty when nothing was pressed). */
  stop(): Phrase {
    this.#active = false;
    const kept = this.#presses;
    this.#presses = [];
    return kept;
  }
}

/** The clock and timers the player runs on: the page's own, or a fake one in a test. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, seconds: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface PlayerOptions {
  /** Do what a press does: the same path as a key or a pad. */
  press: (stage: number) => void;
  timers: Timers;
  /** A pass that was not looped has finished (not called by `stop`). */
  onEnd: () => void;
}

/**
 * Plays a phrase back through the caller's press, once or round and round. Each press is timed from the
 * start of its pass, not from the press before, so a late timer does not pile up into drift.
 */
export class PhrasePlayer {
  readonly #press: (stage: number) => void;
  readonly #timers: Timers;
  readonly #onEnd: () => void;
  #timer: unknown = null;
  #running = false;

  /** Whether the phrase starts over when it ends. */
  loop = false;

  /** Change the loop switch, also while a phrase plays: the pass in hand decides at its end. */
  setLoop(on: boolean): void {
    this.loop = on;
  }

  constructor(options: PlayerOptions) {
    this.#press = options.press;
    this.#timers = options.timers;
    this.#onEnd = options.onEnd;
  }

  get playing(): boolean {
    return this.#running;
  }

  play(phrase: Phrase, loop: boolean): void {
    this.stop();
    if (phrase.length === 0) return;
    this.loop = loop;
    this.#running = true;
    this.#pass(phrase, this.#timers.now());
  }

  stop(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#running = false;
  }

  #at(when: number, fn: () => void): void {
    const delay = Math.max(0, when - this.#timers.now());
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      if (this.#running) fn();
    }, delay);
  }

  #pass(phrase: Phrase, began: number): void {
    const step = (i: number): void => {
      const press = phrase[i];
      if (!press) return;
      try {
        this.#press(press.stage);
      } catch {
        /* one press that cannot play does not stop the phrase */
      }
      if (!this.#running) return;
      const next = phrase[i + 1];
      if (next) {
        this.#at(began + next.at / 100, () => step(i + 1));
        return;
      }
      if (!this.loop) {
        this.#running = false;
        this.#onEnd();
        return;
      }
      const round = began + press.at / 100 + REST;
      this.#at(round, () => {
        if (this.loop) this.#pass(phrase, round);
        else {
          this.#running = false;
          this.#onEnd();
        }
      });
    };
    this.#at(began + (phrase[0]?.at ?? 0) / 100, () => step(0));
  }
}
