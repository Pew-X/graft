/**
 * Where a sketch comes from: the published stage at the root of its path, and the cut and speed of every
 * sketch on the way down to it. A sketch whose parent is a sketch is rendered from that parent's rendered
 * output (the same bytes the service would make from the published parent), so the whole path is a list of
 * steps over one published sound. Walking is bounded (a path longer than twelve, a cycle, or a parent that
 * is not in the book each end it), so a damaged store can never loop the page.
 */
import type { Cut } from "../make/cut.ts";
import { type Book } from "./book.ts";
import { MOST_DEPTH, type Sketch } from "./sketch.ts";

export interface Step {
  cut: Cut;
  p: number;
  q: number;
}

export type Path =
  | {
      ok: true;
      /** The published stage the first step is cut from. */
      root: string;
      /** The sketches on the path, root-most first, ending with the sketch asked about. */
      sketches: Sketch[];
      steps: Step[];
    }
  | { ok: false; why: "missing" | "cycle" | "depth" };

/** The path of the sketch `id`: parents before the sketches that go on from them. */
export function pathOf(book: Book, id: string): Path {
  const down: Sketch[] = [];
  const seen = new Set<string>();
  let at: string | null = id;
  while (at !== null) {
    if (seen.has(at)) return { ok: false, why: "cycle" };
    seen.add(at);
    if (down.length >= MOST_DEPTH) return { ok: false, why: "depth" };
    const s = book.sketches.find((x) => x.id === at);
    if (!s) return { ok: false, why: "missing" };
    down.push(s);
    at = s.parent.kind === "sketch" ? s.parent.id : null;
  }
  const sketches = down.reverse();
  const first = sketches[0];
  if (!first || first.parent.kind !== "stage") return { ok: false, why: "missing" };
  return {
    ok: true,
    root: first.parent.id,
    sketches,
    steps: sketches.map((s) => ({ cut: { ...s.cut }, p: s.p, q: s.q })),
  };
}

/** A key naming a path: the same root and steps are the same sound. */
export function pathKey(root: string, steps: readonly Step[]): string {
  return `${root}|${steps.map((s) => `${s.cut.start}-${s.cut.end}@${s.p}/${s.q}`).join(">")}`;
}

/**
 * The effective parent of a flip made from a sketch, for publishing: the stage a published sketch
 * became, else null (an unpublished sketch cannot be a parent of a publication yet).
 */
export function publishedParent(sketch: Sketch): string | null {
  return sketch.publishedAs ?? null;
}
