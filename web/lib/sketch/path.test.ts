import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { Renderer } from "../make/renderer.ts";
import { type Book, EMPTY } from "./book.ts";
import { canGrow, remaining, stagesUpTo } from "./depth.ts";
import { pathKey, pathOf } from "./path.ts";
import { PathCache } from "./render-path.ts";
import { MOST_DEPTH, type Sketch } from "./sketch.ts";

const STAGE = "es1418qka9yt";
const sk = (n: number, parent: Sketch["parent"], over: Partial<Sketch> = {}): Sketch => ({
  id: `sk${String(n).padStart(12, "0")}`,
  parent,
  cut: { start: 0, end: 4_000 },
  p: 3,
  q: 2,
  title: `s${n}`,
  retryKey: `web-0123456789abcdef0123456789ab${String(n).padStart(2, "0")}`,
  at: n,
  ...over,
});
const book = (sketches: Sketch[]): Book => ({ ...EMPTY, sketches });
const onStage = (n: number) => sk(n, { kind: "stage", id: STAGE });
const onSketch = (n: number, of: Sketch) => sk(n, { kind: "sketch", id: of.id });

test("a sketch cut from a published stage has a path of one step over that stage", () => {
  const a = onStage(1);
  const path = pathOf(book([a]), a.id);
  assert.ok(path.ok);
  assert.equal(path.root, STAGE);
  assert.equal(path.steps.length, 1);
});

test("a sketch that goes on from another has the parent's steps first, in order", () => {
  const a = onStage(1);
  const b = onSketch(2, a);
  const c = onSketch(3, b);
  const path = pathOf(book([c, a, b]), c.id);
  assert.ok(path.ok);
  assert.deepEqual(
    path.sketches.map((s) => s.id),
    [a.id, b.id, c.id],
  );
});

test("a missing parent, a cycle and a path over twelve are each an answer, never a loop", () => {
  const a = onStage(1);
  assert.deepEqual(pathOf(book([a]), "sk" + "9".repeat(12)), { ok: false, why: "missing" });
  const x = sk(5, { kind: "sketch", id: "sk" + "0".repeat(11) + "6" });
  const y = sk(6, { kind: "sketch", id: x.id });
  assert.deepEqual(pathOf(book([x, y]), x.id), { ok: false, why: "cycle" });
  const chain: Sketch[] = [onStage(1)];
  for (let n = 2; n <= MOST_DEPTH + 1; n++) chain.push(onSketch(n, chain[n - 2]!));
  assert.equal(pathOf(book(chain), chain[MOST_DEPTH - 1]!.id).ok, true);
  assert.deepEqual(pathOf(book(chain), chain[MOST_DEPTH]!.id), { ok: false, why: "depth" });
});

test("over random books a path never contains a sketch twice and always starts on a stage", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -1, max: 14 }), { minLength: 1, maxLength: 15 }),
      (parents) => {
        const sketches = parents.map((p, i) =>
          p < 0 || p >= i ? onStage(i) : onSketch(i, sk(p, { kind: "stage", id: STAGE })),
        );
        for (const s of sketches) {
          const r = pathOf(book(sketches), s.id);
          if (r.ok) {
            assert.equal(new Set(r.sketches.map((x) => x.id)).size, r.sketches.length);
            assert.equal(r.sketches[0]?.parent.kind, "stage");
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("the depth budget is the service's: eleven stages above allows one more, twelve none, the seeded four leave eight", () => {
  assert.equal(remaining(4, 0), 8);
  assert.equal(remaining(11, 0), 1);
  assert.ok(canGrow(11, 0));
  assert.equal(remaining(12, 0), 0);
  assert.ok(!canGrow(12, 0));
  assert.equal(remaining(4, 3), 5);
  assert.equal(remaining(30, 0), 0, "never negative");
  assert.equal(stagesUpTo([{ id: "a" }, { id: "b" }, { id: "c" }], "c"), 3);
  assert.equal(stagesUpTo([{ id: "a" }], "z"), null);
});

// a stand-in renderer: the output is the slice, sped by p/q in length; enough to count and compare renders
const fake: Renderer = {
  render(slice: Int16Array, p: number, q: number) {
    const n = Math.floor(((slice.length - 1) * q) / p) + 1;
    return Int16Array.from({ length: n }, (_, i) => (slice[i % slice.length] ?? 0) + 1);
  },
};

test("a path renders each step once however many sketches share it, and a child renders from its parent's output", async () => {
  const root = Int16Array.from({ length: 20_000 }, (_, i) => i % 100);
  const cache = new PathCache();
  const steps = [
    { cut: { start: 0, end: 10_000 }, p: 1, q: 1 },
    { cut: { start: 0, end: 4_000 }, p: 1, q: 1 },
  ];
  const parent = await cache.render(fake, STAGE, root, steps.slice(0, 1));
  const child = await cache.render(fake, STAGE, root, steps);
  const again = await cache.render(fake, STAGE, root, steps);
  assert.ok(parent.ok && child.ok);
  assert.equal(cache.runs, 2, "two steps, each rendered once");
  assert.equal(again, child, "the same path is the same render");
  assert.equal(child.samples[0], parent.samples[0]! + 1, "cut from the parent's output");
  assert.equal(
    pathKey(STAGE, steps),
    pathKey(
      STAGE,
      steps.map((s) => ({ ...s })),
    ),
  );
});

test("a step that breaks a limit says which step, and is asked again next time", async () => {
  const root = Int16Array.from({ length: 20_000 }, () => 1);
  const cache = new PathCache();
  const steps = [
    { cut: { start: 0, end: 10_000 }, p: 1, q: 1 },
    { cut: { start: 0, end: 100 }, p: 1, q: 1 },
  ];
  const r = await cache.render(fake, STAGE, root, steps);
  assert.ok(!r.ok);
  assert.equal(r.step, 1);
  assert.equal(r.problem.kind, "cutShort");
  await cache.render(fake, STAGE, root, steps);
  assert.equal(cache.runs, 3, "the failed step ran again; the good parent did not");
});
