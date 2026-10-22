import createClient from "openapi-fetch";
import type { components, paths } from "./schema.d.ts";

export type Chain = components["schemas"]["ChainView"];
export type Entry = components["schemas"]["EntryView"];

/** A client for the graft API. Its types come from the committed OpenAPI document. */
export function createApi(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}

/**
 * Fetch the chain ending at a publication, source first.
 * A missing publication comes back as `null`; anything else that fails throws.
 */
export async function fetchChain(
  api: ReturnType<typeof createApi>,
  id: string,
): Promise<Chain | null> {
  const { data, error, response } = await api.GET("/v1/chains/{id}", {
    params: { path: { id } },
  });
  if (data) return data;
  if (response.status === 404) return null;
  throw new Error(error?.detail ?? `the chain could not be read (${response.status})`);
}

/** What a reader sees for each entry of a chain: the title, or a marker for a missing parent. */
export function entryLabels(chain: Chain): string[] {
  return chain.stages.map((entry) => (entry.state === "available" ? entry.title : "unavailable"));
}
