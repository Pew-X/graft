/**
 * What the make page is editing, as one plain value: a cut and a speed (the speed as a stop of the
 * committed table). A sketch is a saved copy of exactly this value with a parent and a title beside it,
 * so the page's state and a sketch can never drift apart in shape. Pure: no React, no storage.
 */
import { type Cut, LIMITS } from "./cut.ts";
import { entryAt, indexOf, parseSpeed, step } from "./speed.ts";

/** The first thing heard is a flip, not the sound unchanged: up a fifth. */
export const DEFAULT_SPEED = { p: 3, q: 2 };

export interface Editing {
  cut: Cut;
  /** Index into the speed table. */
  stop: number;
}

/** Where editing starts from, as a link names it (the text of `cut` and `speed`). */
export interface Start {
  cut: string | null;
  speed: string | null;
}

/** "120-480" from a link, or null. Only the shape is checked here; the limits are `checkFlip`'s. */
export function parseCut(text: string | null): Cut | null {
  const m = text?.match(/^(\d{1,7})-(\d{1,7})$/);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/** The cut and speed to open on: the link's where it gives them, else the whole sound (at most the longest cut) at a fifth up. */
export function startEditing(frames: number, start: Start): Editing {
  const given = parseSpeed(start.speed);
  const speed = given ?? DEFAULT_SPEED;
  return {
    cut: parseCut(start.cut) ?? { start: 0, end: Math.min(frames, LIMITS.maxCutFrames) },
    stop: indexOf(speed.p, speed.q),
  };
}

export const withCut = (e: Editing, cut: Cut): Editing => ({ ...e, cut });
export const withStop = (e: Editing, stop: number): Editing => ({ ...e, stop: step(0, stop) });
export const nudge = (e: Editing, delta: number): Editing => ({ ...e, stop: step(e.stop, delta) });

/** The speed fraction of the current stop, and its interval in cents. */
export const speedOf = (e: Editing): { p: number; q: number; cents: number } => entryAt(e.stop);

/** A flip as the service would be asked for it: what a sketch keeps and what publishing sends. */
export interface FlipValue {
  cut: Cut;
  p: number;
  q: number;
}

export function valueOf(e: Editing): FlipValue {
  const { p, q } = entryAt(e.stop);
  return { cut: { ...e.cut }, p, q };
}

/** The editing state that shows exactly this value (its speed snapped to the table, which every kept speed is on). */
export function editingFor(value: FlipValue): Editing {
  return { cut: { ...value.cut }, stop: indexOf(value.p, value.q) };
}
