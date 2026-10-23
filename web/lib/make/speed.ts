/** The speed control's stops: the committed table, walked by index. */
import { RATIO_TABLE } from "./ratio-table.ts";

export interface Stop {
  p: number;
  q: number;
  /** The interval of p/q in whole cents, worked out offline with integers. */
  cents: number;
}

const LAST = RATIO_TABLE.length - 1;

export function entryAt(index: number): Stop {
  const row = RATIO_TABLE[Math.max(0, Math.min(LAST, index))];
  if (row === undefined) throw new RangeError("the ratio table is empty");
  return { p: row[0], q: row[1], cents: row[2] };
}

/** The stop nearest to p/q (by cross-multiplication, no floating point). */
export function indexOf(p: number, q: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i <= LAST; i++) {
    const [tp, tq] = RATIO_TABLE[i] ?? [1, 1];
    // |p/q - tp/tq| compared as |p tq - tp q| / (q tq); the common factor of 1/q is the same for all.
    const gap = Math.abs(p * tq - tp * q) / tq;
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/** Move `delta` stops, stopping at the ends. */
export function step(index: number, delta: number): number {
  return Math.max(0, Math.min(LAST, index + delta));
}

/** "3/2" from a link, accepted only when it is exactly a stop of the table. */
export function parseSpeed(text: string | null): { p: number; q: number } | null {
  const match = text?.match(/^(\d{1,7})\/(\d{1,7})$/);
  if (!match) return null;
  const p = Number(match[1]);
  const q = Number(match[2]);
  return RATIO_TABLE.some(([tp, tq]) => tp === p && tq === q) ? { p, q } : null;
}

export const STOPS = RATIO_TABLE.length;
