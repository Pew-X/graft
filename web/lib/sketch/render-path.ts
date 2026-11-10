/**
 * Render a sketch's whole path in the browser: the first step is cut from the published stage's audio, and
 * every later step is cut from the output of the one before it, with the same code and the same limits the
 * service applies. The result is cached for the page, keyed by the path, so a sketch that goes on from
 * another does not render its parent again, and recursion is bounded by the path's length (twelve).
 */
import { type Made, renderFlip } from "../make/flip.ts";
import type { Renderer } from "../make/renderer.ts";
import { type Step, pathKey } from "./path.ts";

export type Rendered =
  | { ok: true; samples: Int16Array; hash: string }
  | { ok: false; step: number; problem: Extract<Made, { ok: false }>["problem"] };

/** The most paths a page remembers: a bank is twelve, and there is room for the ones on the way. */
const KEEP = 48;

export class PathCache {
  readonly #made = new Map<string, Promise<Rendered>>();
  /** How many renders ran (not found in the cache), for tests and for the page's budget. */
  runs = 0;

  /** The render of `steps` over `root`, from the cache when the same path was asked for before. */
  render(
    renderer: Renderer,
    rootId: string,
    rootSamples: Int16Array,
    steps: readonly Step[],
  ): Promise<Rendered> {
    const key = pathKey(rootId, steps);
    const had = this.#made.get(key);
    if (had) return had;
    const made = this.#make(renderer, rootId, rootSamples, steps);
    this.#made.set(key, made);
    if (this.#made.size > KEEP) {
      const oldest = this.#made.keys().next().value;
      if (oldest !== undefined) this.#made.delete(oldest);
    }
    // a path that failed to render is not remembered as failed: the next ask tries again
    void made.then((r) => {
      if (!r.ok) this.#made.delete(key);
    });
    return made;
  }

  async #make(
    renderer: Renderer,
    rootId: string,
    rootSamples: Int16Array,
    steps: readonly Step[],
  ): Promise<Rendered> {
    if (steps.length === 0) return { ok: true, samples: rootSamples, hash: "" };
    const above = steps.slice(0, -1);
    const parent: Rendered =
      above.length === 0
        ? { ok: true, samples: rootSamples, hash: "" }
        : await this.render(renderer, rootId, rootSamples, above);
    if (!parent.ok) return parent;
    const last = steps[steps.length - 1];
    if (!last) return parent;
    this.runs += 1;
    const made = await renderFlip(renderer, parent.samples, {
      cut: last.cut,
      p: last.p,
      q: last.q,
    });
    return made.ok
      ? { ok: true, samples: made.samples, hash: made.hash }
      : { ok: false, step: steps.length - 1, problem: made.problem };
  }

  clear(): void {
    this.#made.clear();
  }
}
