"use client";

import { useCallback, useSyncExternalStore } from "react";
import { type Chosen, SET_KEY, readChosen, writeChosen } from "../lib/sketch/lease.ts";
import { sketchStorage } from "./useSketchBook.ts";

const CHANGED = "graft:sketch-set";
const EMPTY: Chosen = { ids: [], author: "" };

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

let last: { text: string | null; chosen: Chosen } = { text: null, chosen: EMPTY };
function snapshot(): Chosen {
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(SET_KEY);
  } catch {
    return EMPTY;
  }
  if (text !== last.text) last = { text, chosen: readChosen(sketchStorage()) };
  return last.chosen;
}

/** Which sketches are chosen for "publish these", and the name to publish them under: kept, so a return resumes. */
export function useSketchSet() {
  const chosen = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const save = useCallback((next: Chosen): void => {
    writeChosen(sketchStorage(), next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  const toggle = useCallback(
    (id: string): void => {
      const now = readChosen(sketchStorage());
      save({
        ...now,
        ids: now.ids.includes(id) ? now.ids.filter((x) => x !== id) : [...now.ids, id],
      });
    },
    [save],
  );
  const setAuthor = useCallback(
    (author: string): void => save({ ...readChosen(sketchStorage()), author }),
    [save],
  );
  const clear = useCallback(
    (): void => save({ ids: [], author: readChosen(sketchStorage()).author }),
    [save],
  );
  return { chosen, toggle, setAuthor, clear };
}
