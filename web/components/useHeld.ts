"use client";

import { useEffect, useState } from "react";

/**
 * A value that lets go slowly: while `value` is set it is returned as it is; when it goes null, the last
 * one is returned for `ms` more. The live stage's colour uses this so that stopping the sound lets the
 * thread and the tile fade out in the stage's own colour instead of snapping to green in one frame.
 */
export function useHeld<T>(value: T | null, ms: number): T | null {
  const [held, setHeld] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      // remembered after the page has drawn it: the draw above already uses `value` itself
      queueMicrotask(() => setHeld(value));
      return undefined;
    }
    const id = window.setTimeout(() => setHeld(null), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return value ?? held;
}
