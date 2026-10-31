"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 480px)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Whether the window is a phone's width (the same breakpoint the styles use). False until the page is up. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
