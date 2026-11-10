/**
 * One flip, made in the browser: check the cut and the speed against the limits, cut the slice the
 * cut names, render it with the shared artefact, and hash the canonical bytes. The audio returned is
 * what is heard and what would be sent; the hash is the cross-check the service compares with its
 * own render. All frame handling for a flip is here, so a mistake in it is caught by one test.
 */
import {
  checkCut,
  checkOutput,
  checkSpeed,
  cutSlice,
  outputFrames,
  type Cut,
  type Problem,
} from "./cut.ts";
import { sha256Hex, toBytes, type Renderer } from "./renderer.ts";

export interface FlipSpec {
  cut: Cut;
  p: number;
  q: number;
}

export type Made =
  { ok: true; samples: Int16Array; hash: string } | { ok: false; problem: Problem };

/** Problems with a spec that can be found without rendering, or null. */
export function checkFlip(source: Int16Array, spec: FlipSpec): Problem | null {
  return (
    checkCut(spec.cut, source.length) ??
    checkSpeed(spec.p, spec.q) ??
    checkOutput(outputFrames(spec.cut.end - spec.cut.start, spec.p, spec.q))
  );
}

export async function renderFlip(
  renderer: Renderer,
  source: Int16Array,
  spec: FlipSpec,
): Promise<Made> {
  const problem = checkFlip(source, spec);
  if (problem) return { ok: false, problem };
  const samples = renderer.render(cutSlice(source, spec.cut), spec.p, spec.q);
  return { ok: true, samples, hash: await sha256Hex(toBytes(samples)) };
}
