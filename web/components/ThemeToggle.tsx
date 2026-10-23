"use client";

import { useEffect, useSyncExternalStore } from "react";
import { copy } from "../lib/copy.ts";
import { THEME_KEY } from "../lib/theme/init.ts";

type Mode = "system" | "light" | "dark";
const ORDER: Mode[] = ["system", "light", "dark"];

// The choice lives in this browser if storage lets it, and in memory for the visit if not.
let chosen: Mode | null = null;
const listeners = new Set<() => void>();

function read(): Mode {
  if (chosen !== null) return chosen;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage blocked */
  }
  return "system";
}

function choose(mode: Mode): void {
  chosen = mode;
  try {
    if (mode === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* the choice lasts for this visit */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Follows the system until the visitor picks one. */
export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, read, () => "system" as Mode);
  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
  }, [mode]);
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? "system";
  return (
    <button type="button" className="theme" onClick={() => choose(next)}>
      {copy.theme.label}: {copy.theme[mode]}
    </button>
  );
}
