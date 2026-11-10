/**
 * How much sound a sketch bank holds, so the page can say when it is a lot. A pad's sound is held as
 * 16-bit samples and turned into a float buffer (twice the size again) on the pad's first press, so a
 * long bank is the one place a phone can run short of memory. The seconds are the length of each
 * sketch's rendered output, worked out from its cut and speed.
 */
import { outputFrames } from "../make/cut.ts";
import type { Sketch } from "./sketch.ts";

/** Past this many seconds in all, the page says a phone may run short of memory. */
export const LONG_BANK_SECONDS = 180;

const RATE = 48_000;

/** The seconds of sound on a bank: the sketches whose ids are on it, each as it renders. */
export function bankSeconds(sketches: readonly Sketch[], bank: readonly string[]): number {
  let frames = 0;
  for (const id of bank) {
    const s = sketches.find((x) => x.id === id);
    if (s) frames += outputFrames(s.cut.end - s.cut.start, s.p, s.q);
  }
  return frames / RATE;
}

export const isLongBank = (seconds: number): boolean => seconds > LONG_BANK_SECONDS;
