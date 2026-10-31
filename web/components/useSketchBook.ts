"use client";

import { useSyncExternalStore } from "react";
import { BOOK_KEY, type Book, EMPTY, parseBook } from "../lib/sketch/book.ts";

/** The browser's `storage` event only reaches other tabs; this one tells this tab's own readers. */
const CHANGED = "graft:sketches";

export function announceSketchChange(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export function sketchStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked
  }
}

function subscribe(onChange: () => void): () => void {
  // a sketch kept or discarded in another tab changes what this one shows, without a reload
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

let last: { text: string | null; book: Book } = { text: null, book: EMPTY };

/** The snapshot is the same object while the stored text is the same, so a render is not repeated for nothing. */
function snapshot(): Book {
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(BOOK_KEY);
  } catch {
    return EMPTY;
  }
  if (text !== last.text) last = { text, book: parseBook(text) };
  return last.book;
}

/** Every sketch this browser keeps. Empty before the page is up, and wherever storage cannot be read. */
export function useSketchBook(): Book {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
