import type { components } from "../api/schema.d.ts";

export type FlipItem = components["schemas"]["FlipItem"];
export type FlipsPage = components["schemas"]["FlipsView"];

/** The most flips one page holds on the page of a stage. */
export const PAGE = 24;

/**
 * One page of the flips of a stage, newest first. A stage that is not there is `null`; a service that did
 * not answer properly (asleep, offline, busy) throws, so the caller can say so and ask again.
 */
export async function readFlips(
  apiUrl: string,
  id: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FlipsPage | null> {
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (cursor !== null) query.set("cursor", cursor);
  const response = await fetch(
    `${apiUrl}/v1/publications/${encodeURIComponent(id)}/flips?${query}`,
    signal ? { signal } : {},
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(String(response.status));
  const body = (await response.json()) as Partial<FlipsPage>;
  if (typeof body.total !== "number" || !Array.isArray(body.flips)) throw new Error("shape");
  return { total: body.total, flips: body.flips, next: body.next ?? null };
}
