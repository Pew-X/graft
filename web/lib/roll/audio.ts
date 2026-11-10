/**
 * How the roll gets its audio. The home page's is a handful of static files; a chain read from the
 * service has a short-lived address per stage that can be heard, issued on the read, so a stage that
 * is hidden or held is never asked for. If an address has expired by the time it is used (the page sat
 * open, the network was slow), the chain is read again for fresh ones and the stage is tried once more.
 */
import type { Chain } from "../api/chain.ts";
import { HttpError, fetchPcm } from "./pcm.ts";

/** Loads every stage's audio, in order; `null` for a stage that has none to play. */
export type Loader = (signal: AbortSignal) => Promise<Array<Int16Array | null>>;

export function staticLoader(paths: ReadonlyArray<string | null>): Loader {
  return (signal) => Promise.all(paths.map((p) => (p === null ? null : fetchPcm(p, signal))));
}

interface Deps {
  /** Read the chain from the service: null when there is no such chain. */
  chain: () => Promise<Chain | null>;
  pcm?: (url: string, signal?: AbortSignal) => Promise<Int16Array>;
}

/** The status of an address that has expired or was refused. */
const EXPIRED = new Set([401, 403, 410]);

function addresses(chain: Chain): Array<string | null> {
  return chain.stages.map((entry) => (entry.state === "available" ? entry.audio.url : null));
}

export function liveLoader({ chain, pcm = fetchPcm }: Deps): Loader {
  return async (signal) => {
    const first = await chain();
    if (first === null) throw new Error("the chain is no longer there");
    let urls = addresses(first);
    // Which set of addresses is current, and the read that is fetching the next set, if any. When
    // several stages find their address expired at once they share one fresh read of the chain.
    let generation = 0;
    let refreshing: Promise<void> | null = null;
    const refresh = (seen: number): Promise<void> => {
      if (generation !== seen) return Promise.resolve(); // someone already got newer addresses
      refreshing ??= (async () => {
        const fresh = await chain();
        if (fresh === null) throw new Error("the chain is no longer there");
        urls = addresses(fresh);
        generation += 1;
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    };
    const fetchStage = async (index: number): Promise<Int16Array | null> => {
      const seen = generation;
      const url = urls[index];
      if (url === null || url === undefined) return null;
      try {
        return await pcm(url, signal);
      } catch (error) {
        if (!(error instanceof HttpError) || !EXPIRED.has(error.status)) throw error;
        // Expired: get fresh addresses and try this stage again, once.
        await refresh(seen);
        const fresh = urls[index];
        return fresh === null || fresh === undefined ? null : pcm(fresh, signal);
      }
    };
    return Promise.all(urls.map((_, index) => fetchStage(index)));
  };
}
