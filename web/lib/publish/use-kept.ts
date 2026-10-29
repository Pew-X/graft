"use client";

import { useSyncExternalStore } from "react";
import { flipIds } from "../flips/list.ts";
import { keptKeys } from "./keep.ts";

function subscribe(onChange: () => void): () => void {
  // another tab publishing or forgetting a flip changes what this browser holds
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function holds(): boolean {
  try {
    return flipIds(keptKeys(window.localStorage)).length > 0;
  } catch {
    return false; // storage blocked
  }
}

/** Whether this browser holds the manage key of at least one flip (nothing is assumed before the page is up). */
export function useHoldsFlips(): boolean {
  return useSyncExternalStore(subscribe, holds, () => false);
}
