"use client";

import { useEffect, useState } from "react";
import { useAsync, type Async } from "../lib/make/use-async.ts";
import { type Shown, readPublication } from "../lib/manage/read.ts";

/** How long a read waits before it asks the service again, and how many times: a service that was asleep needs about a minute. */
export const ASK_AGAIN_MS = 6_000;
export const ASK_AGAIN_TIMES = 20;

/**
 * One public read of a publication that asks again by itself while the service does not answer (it may
 * have been asleep): for a few minutes, every few seconds. `null` inside a ready read is "no such publication".
 */
export function usePublicationRead(
  apiUrl: string,
  id: string,
  round = 0,
): { read: Async<Shown | null>; failed: boolean } {
  const [again, setAgain] = useState(0);
  const read = useAsync(`flip:${id}:${round}:${again}`, (signal) =>
    readPublication(apiUrl, id, signal),
  );
  const failed = read.status === "failed";
  useEffect(() => {
    if (!failed || again >= ASK_AGAIN_TIMES) return undefined;
    const timer = window.setTimeout(() => setAgain((n) => n + 1), ASK_AGAIN_MS);
    return () => window.clearTimeout(timer);
  }, [failed, again]);
  return { read, failed };
}
