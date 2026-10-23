/**
 * The browser's side of the event path: three kinds of event, batched, sent best-effort. The privacy
 * design is the point. The session id exists only in this object's memory, never in storage or a
 * cookie, groups one visit's events and is replaced after thirty quiet minutes, so it cannot link
 * visits. Events carry ids and a kind and nothing else. If a privacy signal is on, nothing is queued,
 * no timer is set and nothing is sent. Failures are bounded and silent: telemetry may lose events,
 * and may never change what the page does.
 */

export type EventKind = "roll_opened" | "stage_played" | "flip_started";

/** What the service answered. */
export interface Reply {
  status: number;
  /** From a 429's Retry-After header. */
  retryAfterSeconds?: number;
}
export type Post = (url: string, body: string, keepalive: boolean) => Promise<Reply>;

export interface Deps {
  endpoint: string;
  /** A privacy signal is on: do nothing at all. */
  gated: boolean;
  now: () => number;
  /** A random string of `n` characters from `A-Za-z0-9_-`. */
  random: (n: number) => string;
  post: Post;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

interface Pending {
  event_id: string;
  session_id: string;
  kind: EventKind;
  occurred_at_ms: number;
  publication_id: string;
}

const BATCH = 10;
const FLUSH_AFTER_MS = 5_000;
const MAX_QUEUE = 100;
/** Retries after the first try, and how long before each. */
const RETRY_DELAYS_MS = [1_000, 3_000];
const SESSION_IDLE_MS = 30 * 60_000;
const DEFAULT_PAUSE_SECONDS = 60;

export class Telemetry {
  readonly #d: Deps;
  #queue: Pending[] = [];
  #timer: number | null = null;
  #stopped = false;
  #pausedUntil = 0;
  #session: { id: string; last: number } | null = null;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  /** Events waiting to be sent. */
  get queued(): number {
    return this.#queue.length;
  }

  /** The service said publishing (and so reporting) is off; nothing more is sent this page load. */
  get stopped(): boolean {
    return this.#stopped;
  }

  track(kind: EventKind, publicationId: string): void {
    try {
      const d = this.#d;
      if (d.gated || this.#stopped || d.now() < this.#pausedUntil) return;
      this.#queue.push({
        event_id: d.random(22),
        session_id: this.#sessionId(),
        kind,
        occurred_at_ms: d.now(),
        publication_id: publicationId,
      });
      if (this.#queue.length > MAX_QUEUE) this.#queue.splice(0, this.#queue.length - MAX_QUEUE);
      if (this.#queue.length >= BATCH) {
        void this.flush();
      } else if (this.#timer === null) {
        this.#timer = d.setTimeout(() => void this.flush(), FLUSH_AFTER_MS);
      }
    } catch {
      /* telemetry never throws into the page */
    }
  }

  /** Send what is waiting. `keepalive` lets the request outlive the page. */
  async flush(keepalive = false): Promise<void> {
    try {
      if (this.#timer !== null) this.#d.clearTimeout(this.#timer);
      this.#timer = null;
      while (this.#queue.length > 0 && !this.#stopped) {
        await this.#attempt(this.#queue.splice(0, BATCH), 0, keepalive);
      }
    } catch {
      /* ignore */
    }
  }

  /** The page is being hidden or left: send now, in a request that outlives it. */
  pageHide(): void {
    void this.flush(true);
  }

  #sessionId(): string {
    const now = this.#d.now();
    if (this.#session === null || now - this.#session.last > SESSION_IDLE_MS) {
      this.#session = { id: this.#d.random(22), last: now };
    }
    this.#session.last = now;
    return this.#session.id;
  }

  /** One try at a batch; a failure schedules the next try rather than waiting for it. */
  async #attempt(batch: Pending[], tried: number, keepalive: boolean): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.#d.post(this.#d.endpoint, JSON.stringify({ events: batch }), keepalive);
    } catch {
      this.#retry(batch, tried);
      return;
    }
    if (reply.status >= 200 && reply.status < 300) return;
    if (reply.status === 503) {
      // The service's kill switch: stop for the rest of this page load.
      this.#stopped = true;
      this.#queue = [];
      return;
    }
    if (reply.status === 429) {
      // Told to slow down: discard this batch and what is waiting, and stay quiet for the time given.
      this.#queue = [];
      this.#pausedUntil =
        this.#d.now() + (reply.retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS) * 1_000;
      return;
    }
    if (reply.status >= 500) this.#retry(batch, tried);
    // Any other refusal (422 and the rest) would be refused again: discard it.
  }

  #retry(batch: Pending[], tried: number): void {
    const delay = RETRY_DELAYS_MS[tried];
    if (delay === undefined || this.#stopped) return; // given up: best-effort counts may be lost
    this.#d.setTimeout(() => void this.#attempt(batch, tried + 1, false), delay);
  }
}
