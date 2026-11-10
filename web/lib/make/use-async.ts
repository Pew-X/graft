"use client";

import { useEffect, useRef, useState } from "react";

export type Async<T> =
  | { status: "idle" }
  /** `previous` is the last answer to an earlier request, so a screen need not blank between two. */
  | { status: "loading"; previous?: T }
  | { status: "failed"; error: unknown }
  | { status: "ready"; value: T };

type Done<T> = { key: string; result: { ok: true; value: T } | { ok: false; error: unknown } };

/**
 * Run `load` whenever `key` changes and report where it stands; `null` means nothing to load. The key
 * says what is wanted, so a new key abandons the old request and an answer to an abandoned request
 * is never shown. The status is worked out while rendering, so no state is set in the effect itself.
 */
export function useAsync<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
): Async<T> {
  const [done, setDone] = useState<Done<T> | null>(null);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    latest.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setDone({ key, result: { ok: true, value } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDone({ key, result: { ok: false, error } });
      },
    );
    return () => controller.abort();
  }, [key]);
  if (key === null) return { status: "idle" };
  if (done === null || done.key !== key) {
    return done?.result.ok
      ? { status: "loading", previous: done.result.value }
      : { status: "loading" };
  }
  return done.result.ok
    ? { status: "ready", value: done.result.value }
    : { status: "failed", error: done.result.error };
}
