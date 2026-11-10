import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outcome, PublishBody, Refusal } from "../publish/client.ts";
import { type Book, EMPTY } from "./book.ts";
import { type ItemState, MOST_PER_SET, type SetDeps, planSet, runSet } from "./set.ts";
import type { Sketch } from "./sketch.ts";

const STAGE = "es1418qka9yt";
const sk = (
  n: number,
  parent: Sketch["parent"] = { kind: "stage", id: STAGE },
  over: Partial<Sketch> = {},
): Sketch => ({
  id: `sk${String(n).padStart(12, "0")}`,
  parent,
  cut: { start: 0, end: 1000 + n },
  p: 3,
  q: 2,
  title: `s${n}`,
  retryKey: `web-0123456789abcdef0123456789ab${String(n).padStart(2, "0")}`,
  at: n,
  ...over,
});
const on = (of: Sketch, n: number, over: Partial<Sketch> = {}): Sketch =>
  sk(n, { kind: "sketch", id: of.id }, over);
const book = (sketches: Sketch[]): Book => ({ ...EMPTY, sketches });

test("a set is in parent-first order, brings an unchosen parent in, and skips what is already published", () => {
  const a = sk(1);
  const b = on(a, 2);
  const c = on(b, 3);
  const done = sk(4, undefined, { publishedAs: "aaaaaaaaaaaa" });
  const plan = planSet(book([a, b, c, done]), [c.id, done.id]);
  assert.deepEqual(
    plan.order.map((s) => s.id),
    [a.id, b.id, c.id],
  );
  assert.deepEqual(
    plan.pulledIn.map((s) => s.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    plan.alreadyPublished.map((s) => s.id),
    [done.id],
  );
});

test("a published parent is not brought in again, and what goes on from it publishes from its stage", () => {
  const a = sk(1, undefined, { publishedAs: "aaaaaaaaaaaa" });
  const b = on(a, 2);
  const plan = planSet(book([a, b]), [b.id]);
  assert.deepEqual(
    plan.order.map((s) => s.id),
    [b.id],
  );
  assert.equal(plan.pulledIn.length, 0);
});

test("a press sends twelve at most and names the rest", () => {
  const many = Array.from({ length: 15 }, (_, i) => sk(i + 1));
  const plan = planSet(
    book(many),
    many.map((s) => s.id),
  );
  assert.equal(plan.order.length, MOST_PER_SET);
  assert.equal(plan.leftOut.length, 3);
});

/** A fake world: a book that remembers what was marked, kept keys, and a service that answers as scripted. */
function world(order: Sketch[], script: Array<(body: PublishBody) => Outcome | "lose">) {
  let current = book(order);
  const calls: string[] = [];
  const bodies: PublishBody[] = [];
  const kept = new Map<string, string>();
  let n = 0;
  const abort = new AbortController();
  const updates: Array<ReadonlyMap<string, ItemState>> = [];
  const deps: SetDeps = {
    readBook: () => current,
    render: async (s) => ({ ok: true, hash: `hash-${s.id}` }),
    post: async (body) => {
      bodies.push(body);
      calls.push(`post:${body.retry_key.slice(-2)}`);
      const next = script[n++] ?? ((b: PublishBody) => published(b));
      const made = next(body);
      if (made === "lose") return { kind: "gaveUp", attempts: 4, why: "network" };
      return made;
    },
    keepKey: (id, key) => {
      calls.push(`keep:${id}`);
      kept.set(id, key);
      return true;
    },
    holdsKey: (id) => kept.has(id),
    markPublished: (sketchId, pub) => {
      calls.push(`mark:${sketchId.slice(-2)}`);
      current = book(
        current.sketches.map((s) => (s.id === sketchId ? { ...s, publishedAs: pub } : s)),
      );
    },
    author: "me",
    signal: abort.signal,
    onUpdate: (states) => updates.push(states),
  };
  return {
    deps,
    calls,
    bodies,
    kept,
    abort,
    updates,
    get book() {
      return current;
    },
  };
}

let counter = 0;
const published = (
  body: PublishBody,
  over: Partial<Extract<Outcome, { kind: "published" }>> = {},
): Outcome => ({
  kind: "published",
  created: true,
  id: `p${String(++counter).padStart(11, "a")}`.slice(0, 12).replace(/[ilou]/g, "k"),
  manageKey: `key-for-${body.retry_key.slice(-2)}`,
  previewMatches: true,
  adjusted: [],
  ...over,
});
const refused = (refusal: Refusal): Outcome => ({ kind: "refused", refusal });

test("each sketch is published in order with its own retry key, from its parent's publication, and the key is kept before it is marked", async () => {
  const a = sk(1);
  const b = on(a, 2);
  const w = world([a, b], []);
  const result = await runSet([a, b], w.deps);
  assert.equal(result.published, 2);
  assert.deepEqual(w.calls, [
    "post:01",
    `keep:${[...w.kept.keys()][0]}`,
    "mark:01",
    "post:02",
    `keep:${[...w.kept.keys()][1]}`,
    "mark:02",
  ]);
  assert.equal(w.bodies[0]?.parent_id, STAGE);
  assert.equal(
    w.bodies[1]?.parent_id,
    [...w.kept.keys()][0],
    "the child is published from its parent's id",
  );
  assert.equal(w.bodies[0]?.retry_key, a.retryKey);
  assert.equal(w.bodies[0]?.preview_hash, `hash-${a.id}`);
  assert.equal(w.bodies[0]?.author, "me");
});

test("a stop part way leaves the rest waiting, and a resume publishes the rest exactly once", async () => {
  const [a, b, c] = [sk(1), sk(2), sk(3)] as [Sketch, Sketch, Sketch];
  const w = world([a, b, c], [(x) => published(x), () => "lose"]);
  const first = await runSet([a, b, c], w.deps);
  assert.equal(first.published, 1);
  assert.equal(first.waiting, 2);
  assert.equal(first.stoppedAt, b.id);
  assert.deepEqual(first.states.get(b.id), {
    status: "stopped",
    why: { kind: "gaveUp", why: "network" },
  });
  // resume: the first is already marked and is not sent again
  const second = await runSet([a, b, c], { ...w.deps, signal: new AbortController().signal });
  assert.equal(second.published, 3);
  const posts = w.calls.filter((c) => c.startsWith("post"));
  assert.deepEqual(
    posts,
    ["post:01", "post:02", "post:02", "post:03"],
    "the second sketch was tried twice, with the same key",
  );
});

test("an answer lost after the service made the flip: the replay is 'already published', and with no key held it says the key is lost", async () => {
  const a = sk(1);
  const w = world(
    [a],
    [() => "lose", (body) => published(body, { created: false, manageKey: null })],
  );
  await runSet([a], w.deps);
  const again = await runSet([a], w.deps);
  const state = again.states.get(a.id);
  assert.equal(state?.status, "published");
  assert.ok(state?.status === "published" && state.created === false && state.keyLost === true);
});

test("a limit stops the set at that sketch and says how many were published and how many wait; the rest are untouched", async () => {
  const [a, b, c] = [sk(1), sk(2), sk(3)] as [Sketch, Sketch, Sketch];
  for (const kind of ["rateLimited", "publishCap", "forkCap"] as const) {
    const w = world(
      [a, b, c],
      [(x) => published(x), () => refused({ kind, retryAfterSecs: 1200 })],
    );
    const r = await runSet([a, b, c], w.deps);
    assert.equal(r.published, 1, kind);
    assert.equal(r.waiting, 2, kind);
    assert.deepEqual(r.states.get(c.id), { status: "waiting" });
    assert.equal(
      w.calls.filter((x) => x.startsWith("post")).length,
      2,
      `${kind}: nothing after the refusal is sent`,
    );
  }
});

test("a title the service refuses stops the set at that sketch, and nothing was recorded for it", async () => {
  const [a, b] = [sk(1), sk(2)] as [Sketch, Sketch];
  const w = world(
    [a, b],
    [() => refused({ kind: "invalid", field: "title", rule: "denied_word" })],
  );
  const r = await runSet([a, b], w.deps);
  assert.equal(r.stoppedAt, a.id);
  assert.equal(w.book.sketches[0]?.publishedAs, undefined);
});

test("a parent that went away skips that sketch and what goes on from it, and the others continue", async () => {
  const a = sk(1);
  const child = on(a, 2);
  const other = sk(3);
  const w = world([a, child, other], [() => refused({ kind: "parentGone" })]);
  const r = await runSet([a, child, other], w.deps);
  assert.deepEqual(r.states.get(a.id), { status: "skipped", why: { kind: "parentGone" } });
  assert.deepEqual(r.states.get(child.id), { status: "skipped", why: "parent" });
  assert.equal(r.states.get(other.id)?.status, "published");
  assert.equal(r.stoppedAt, null);
});

test("a render that differs from the service's publishes that sketch, then stops before anything goes on from it", async () => {
  const a = sk(1);
  const b = on(a, 2);
  const w = world([a, b], [(x) => published(x, { previewMatches: false })]);
  const r = await runSet([a, b], w.deps);
  assert.equal(r.states.get(a.id)?.status, "published");
  assert.deepEqual(r.states.get(b.id), { status: "stopped", why: { kind: "mismatch" } });
  assert.equal(w.calls.filter((x) => x.startsWith("post")).length, 1);
});

test("a sketch that cannot be rendered stops the set before anything is sent for it", async () => {
  const a = sk(1);
  const w = world([a], []);
  const r = await runSet([a], {
    ...w.deps,
    render: async () => ({ ok: false, why: "its parent is too short" }),
  });
  assert.equal(r.stoppedAt, a.id);
  assert.equal(w.calls.length, 0);
});

test("cancelling stops cleanly, and what was published stays published", async () => {
  const [a, b] = [sk(1), sk(2)] as [Sketch, Sketch];
  const w = world(
    [a, b],
    [
      (x) => {
        w.abort.abort();
        return published(x);
      },
    ],
  );
  const r = await runSet([a, b], w.deps);
  assert.equal(r.published, 1);
  assert.deepEqual(r.states.get(b.id), { status: "stopped", why: { kind: "cancelled" } });
});

test("a sketch published by another tab since the run began is not sent again", async () => {
  const a = sk(1);
  const w = world([a], []);
  w.deps.markPublished(a.id, "aaaaaaaaaaaa");
  const r = await runSet([a], w.deps);
  assert.equal(w.bodies.length, 0);
  assert.equal(r.states.get(a.id)?.status, "published");
});

test("a sketch's note is sent with it only to a service that has notes", async () => {
  const a = sk(1, undefined, { note: "from the lake" });
  const plain = sk(2);
  const withNotes = world([a, plain], []);
  await runSet([a, plain], { ...withNotes.deps, notes: true });
  assert.equal((withNotes.bodies[0] as { note?: string }).note, "from the lake");
  assert.equal("note" in (withNotes.bodies[1] ?? {}), false, "no note, no field");
  const without = world([a], []);
  await runSet([a], without.deps);
  assert.equal("note" in (without.bodies[0] ?? {}), false, "an older service never sees the field");
});
