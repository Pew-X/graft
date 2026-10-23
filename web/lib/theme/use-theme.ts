"use client";

import { useSyncExternalStore } from "react";

export type Resolved = "light" | "dark";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  // The toggle sets data-theme on the document: watch it.
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    media.removeEventListener("change", onChange);
    watch.disconnect();
  };
}

function snapshot(): Resolved {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme in force: the visitor's choice if they made one, else the system's. */
export function useResolvedTheme(): Resolved {
  return useSyncExternalStore(subscribe, snapshot, () => "light");
}
