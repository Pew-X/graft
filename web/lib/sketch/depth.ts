/**
 * How many more stages a path can still grow by, worked out the way the service decides. The service
 * refuses a publish when the parent's chain already has twelve stages, so a parent chain of eleven still
 * allows one more and twelve allows none. For a sketch about to be kept, `above` is the number of sketches
 * already above it on its path (none for a sketch cut from a published stage).
 */
import { MOST_DEPTH } from "./sketch.ts";

/** How many more stages may be added, counting the one being made: 12 minus the stages above it. */
export function remaining(stagesInParentChain: number, above: number): number {
  return Math.max(0, MOST_DEPTH - stagesInParentChain - above);
}

/** Whether one more sketch can be kept on this path and still be published. */
export const canGrow = (stagesInParentChain: number, above: number): boolean =>
  remaining(stagesInParentChain, above) > 0;

/** The number of stages in the chain that ends at `id`, from a shipped chain (source first), or null when `id` is not in it. */
export function stagesUpTo(chain: ReadonlyArray<{ id: string }>, id: string): number | null {
  const at = chain.findIndex((s) => s.id === id);
  return at < 0 ? null : at + 1;
}
