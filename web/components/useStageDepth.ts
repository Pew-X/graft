"use client";

import { createApi, fetchChain } from "../lib/api/chain.ts";
import { useAsync } from "../lib/make/use-async.ts";
import { MOST_DEPTH } from "../lib/sketch/sketch.ts";

export type StageDepth =
  { state: "known"; stages: number } | { state: "checking" } | { state: "failed" };

/**
 * How many stages the chain ending at a published stage has. A stage that ships with the site is known at
 * once (no read); any other is asked of the service, and says "checking" until it answers, never a
 * guessed number. A chain the service reports as cut short is at least as long as it can be read.
 */
export function useStageDepth(
  apiUrl: string,
  id: string | null,
  shipped: number | null,
): StageDepth {
  const read = useAsync(id !== null && shipped === null ? `depth:${id}` : null, async (signal) => {
    void signal;
    const chain = await fetchChain(createApi(apiUrl), id ?? "");
    if (chain === null) throw new Error("not found");
    return chain.truncated ? MOST_DEPTH : chain.stages.length;
  });
  if (shipped !== null) return { state: "known", stages: shipped };
  if (id === null) return { state: "checking" };
  if (read.status === "ready") return { state: "known", stages: read.value };
  if (read.status === "failed") return { state: "failed" };
  return { state: "checking" };
}
