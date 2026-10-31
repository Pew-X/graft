/**
 * Publishing a set of sketches: several flips, in the right order, one after another, through the one
 * publish call the service already has. Nothing is batched on the service: each sketch is a whole public
 * flip, so a set that stops half way is a valid shorter chain, and can be resumed without publishing
 * anything twice because every sketch carries its own retry key (a replay answers "already published").
 *
 * The rules this module keeps, each tested:
 *  - parents before the sketches that go on from them, and a chosen sketch brings its unpublished parent in;
 *  - the manage key of a flip is written to this browser BEFORE anything else happens (before the sketch is
 *    marked published, before any screen changes): the one case it cannot cover is an answer lost in transit
 *    after the service made the flip, and that is said in words;
 *  - a refusal that is about the whole service (a limit, the switch, a storage ceiling) or about a title stops
 *    the set at that sketch and leaves the rest waiting; a refusal about one parent (gone, held, closed, too
 *    deep) skips that sketch and what goes on from it, and the rest continue;
 *  - a render that differs from the service's stops the set after that sketch, because what goes on from it
 *    was rendered from a sound the service does not hold.
 */
import type { Outcome, PublishBody, Refusal } from "../publish/client.ts";
import type { Book } from "./book.ts";
import { MOST_DEPTH, type Sketch } from "./sketch.ts";

/** Most sketches one "publish these" press sends (the depth limit and the hour's allowance make more unhelpful). */
export const MOST_PER_SET = 12;

export interface SetPlan {
  /** What will be published, parents first. */
  order: Sketch[];
  /** Sketches that were not chosen but are brought in because a chosen one goes on from them. */
  pulledIn: Sketch[];
  /** Chosen (or brought in) sketches beyond the twelve this press sends. */
  leftOut: Sketch[];
  /** Chosen sketches that are already published and are not published again. */
  alreadyPublished: Sketch[];
}

export function planSet(book: Book, chosen: readonly string[]): SetPlan {
  const byId = new Map(book.sketches.map((s) => [s.id, s]));
  const want = new Set<string>();
  const pulled = new Set<string>();
  const alreadyPublished: Sketch[] = [];
  const add = (s: Sketch, direct: boolean, depth: number): void => {
    if (s.publishedAs !== undefined) {
      if (direct) alreadyPublished.push(s);
      return;
    }
    if (want.has(s.id) || depth > MOST_DEPTH) return;
    want.add(s.id);
    if (!direct) pulled.add(s.id);
    if (s.parent.kind === "sketch") {
      const parent = byId.get(s.parent.id);
      if (parent) add(parent, false, depth + 1);
    }
  };
  for (const id of chosen) {
    const s = byId.get(id);
    if (s) add(s, true, 0);
  }
  // parents first: a stable order by when each was kept, then lifted so no sketch precedes its parent
  const ordered: Sketch[] = [];
  const placed = new Set<string>();
  const place = (s: Sketch): void => {
    if (placed.has(s.id) || !want.has(s.id)) return;
    placed.add(s.id);
    if (s.parent.kind === "sketch") {
      const parent = byId.get(s.parent.id);
      if (parent) place(parent);
    }
    ordered.push(s);
  };
  [...want]
    .map((id) => byId.get(id))
    .filter((s): s is Sketch => s !== undefined)
    .sort((a, b) => a.at - b.at)
    .forEach(place);
  const order = ordered.slice(0, MOST_PER_SET);
  return {
    order,
    pulledIn: order.filter((s) => pulled.has(s.id)),
    leftOut: ordered.slice(MOST_PER_SET),
    alreadyPublished,
  };
}

export type StopWhy =
  | { kind: "refusal"; refusal: Refusal }
  | { kind: "gaveUp"; why: "network" | "busy" | "server" }
  | { kind: "mismatch" }
  | { kind: "render"; why: string }
  | { kind: "cancelled" };

export type ItemState =
  | { status: "waiting" }
  | { status: "publishing"; attempt: number; of: number }
  | {
      status: "published";
      id: string;
      /** False when the service answered with the flip an earlier try made: nothing was made twice. */
      created: boolean;
      /** The key is in this browser's kept keys. */
      keyKept: boolean;
      /** A replay returns no key: if none is held, this flip can no longer be managed from here. */
      keyLost: boolean;
    }
  | { status: "stopped"; why: StopWhy }
  | { status: "skipped"; why: "parent" | Refusal };

export interface SetDeps {
  readBook: () => Book;
  /** The hash of the sound this sketch renders to here, or why it cannot be rendered. */
  render: (sketch: Sketch) => Promise<{ ok: true; hash: string } | { ok: false; why: string }>;
  /** One publish, with its retries; the sketch's own retry key is in the body. */
  post: (
    body: PublishBody,
    onAttempt: (attempt: number, of: number) => void,
    signal: AbortSignal,
  ) => Promise<Outcome>;
  /** Write a manage key to this browser. False when it could not be written. */
  keepKey: (publicationId: string, key: string) => boolean;
  /** Whether this browser already holds the key of a publication. */
  holdsKey: (publicationId: string) => boolean;
  markPublished: (sketchId: string, publicationId: string) => void;
  /** The name the whole set is published under. */
  author: string;
  signal: AbortSignal;
  /** Called after every change, with every sketch's state. */
  onUpdate: (states: ReadonlyMap<string, ItemState>, keys: ReadonlyMap<string, string>) => void;
}

/** Refusals that are about one parent, not about the service: skip this sketch and what goes on from it. */
const ABOUT_THE_PARENT = new Set<Refusal["kind"]>([
  "parentGone",
  "parentHeld",
  "forkClosed",
  "depthCap",
]);

export interface SetResult {
  states: Map<string, ItemState>;
  /** Manage keys received in this run, by publication id (also kept in the browser when it would hold them). */
  keys: Map<string, string>;
  published: number;
  waiting: number;
  stoppedAt: string | null;
}

export async function runSet(order: readonly Sketch[], deps: SetDeps): Promise<SetResult> {
  const states = new Map<string, ItemState>(
    order.map((s) => [s.id, { status: "waiting" } satisfies ItemState]),
  );
  const keys = new Map<string, string>();
  const say = (): void => deps.onUpdate(new Map(states), new Map(keys));
  let stoppedAt: string | null = null;
  say();
  for (const sketch of order) {
    if (stoppedAt !== null) break;
    if (deps.signal.aborted) {
      states.set(sketch.id, { status: "stopped", why: { kind: "cancelled" } });
      stoppedAt = sketch.id;
      break;
    }
    const book = deps.readBook();
    const here = book.sketches.find((s) => s.id === sketch.id) ?? sketch;
    if (here.publishedAs !== undefined) {
      // published by an earlier run (or another tab) since this one began: nothing to do, nothing twice
      states.set(sketch.id, {
        status: "published",
        id: here.publishedAs,
        created: false,
        keyKept: deps.holdsKey(here.publishedAs),
        keyLost: !deps.holdsKey(here.publishedAs),
      });
      say();
      continue;
    }
    const parentStage =
      here.parent.kind === "stage"
        ? here.parent.id
        : (book.sketches.find((s) => s.id === (here.parent as { id: string }).id)?.publishedAs ??
          null);
    if (parentStage === null) {
      states.set(sketch.id, { status: "skipped", why: "parent" });
      say();
      continue;
    }
    states.set(sketch.id, { status: "publishing", attempt: 1, of: 1 });
    say();
    const rendered = await deps.render(here);
    if (!rendered.ok) {
      states.set(sketch.id, { status: "stopped", why: { kind: "render", why: rendered.why } });
      stoppedAt = sketch.id;
      say();
      break;
    }
    const outcome = await deps.post(
      {
        parent_id: parentStage,
        cut: { start: here.cut.start, end: here.cut.end },
        speed: { p: here.p, q: here.q },
        title: here.title,
        author: deps.author,
        retry_key: here.retryKey,
        preview_hash: rendered.hash,
      },
      (attempt, of) => {
        states.set(sketch.id, { status: "publishing", attempt, of });
        say();
      },
      deps.signal,
    );
    if (outcome.kind === "published") {
      // the key first: before the sketch is marked, before any screen changes
      let keyKept = deps.holdsKey(outcome.id);
      if (outcome.manageKey !== null) {
        keys.set(outcome.id, outcome.manageKey);
        keyKept = deps.keepKey(outcome.id, outcome.manageKey);
      }
      deps.markPublished(sketch.id, outcome.id);
      states.set(sketch.id, {
        status: "published",
        id: outcome.id,
        created: outcome.created,
        keyKept,
        keyLost: outcome.manageKey === null && !keyKept,
      });
      say();
      if (outcome.previewMatches === false) {
        // what goes on from this was rendered from a sound the service does not hold
        const next = order[order.indexOf(sketch) + 1];
        if (next) {
          states.set(next.id, { status: "stopped", why: { kind: "mismatch" } });
          stoppedAt = next.id;
        } else stoppedAt = sketch.id;
        say();
      }
      continue;
    }
    if (outcome.kind === "refused") {
      if (ABOUT_THE_PARENT.has(outcome.refusal.kind)) {
        states.set(sketch.id, { status: "skipped", why: outcome.refusal });
        say();
        continue;
      }
      states.set(sketch.id, {
        status: "stopped",
        why: { kind: "refusal", refusal: outcome.refusal },
      });
      stoppedAt = sketch.id;
      say();
      break;
    }
    if (outcome.kind === "gaveUp") {
      states.set(sketch.id, { status: "stopped", why: { kind: "gaveUp", why: outcome.why } });
    } else {
      states.set(sketch.id, { status: "stopped", why: { kind: "cancelled" } });
    }
    stoppedAt = sketch.id;
    say();
    break;
  }
  let published = 0;
  let waiting = 0;
  for (const s of states.values()) {
    if (s.status === "published") published++;
    if (s.status === "waiting" || s.status === "stopped") waiting++;
  }
  return { states, keys, published, waiting, stoppedAt };
}
