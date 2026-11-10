/**
 * A speed typed as a percentage. The renderer accepts any ratio between 1/4 and 4, but the editor walks
 * a committed table of stops (25 cents apart), so a typed number is snapped to the nearest stop and
 * the snap is said when it shows: typing 210 gives "snapped to 209%". Pure.
 */
import { describeSpeed } from "../roll/speed.ts";
import { entryAt, indexOf } from "./speed.ts";

export const MIN_PERCENT = 25;
export const MAX_PERCENT = 400;

export type TypedSpeed =
  | { ok: true; stop: number; percent: string; snapped: boolean }
  | { ok: false; why: "empty" | "number" | "range" };

/** Hundredths of a percent as a whole number, from text like "148", "148%", "148.5 %" or "1,5". */
function hundredths(text: string): number | null {
  const m = text
    .trim()
    .replace(/\s*%$/, "")
    .replace(",", ".")
    .match(/^(\d{1,4})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function typedSpeed(text: string): TypedSpeed {
  if (text.trim() === "") return { ok: false, why: "empty" };
  const h = hundredths(text);
  if (h === null) return { ok: false, why: "number" };
  if (h < MIN_PERCENT * 100 || h > MAX_PERCENT * 100) return { ok: false, why: "range" };
  // the ratio h/10000 by cross-multiplication, no floating point
  const stop = indexOf(h, 10_000);
  const row = entryAt(stop);
  const percent = describeSpeed(row.p, row.q).percent;
  // "snapped" is said only when the speed shown differs from the number typed (to a whole percent): typing 148
  // and getting a stop that reads 148% is just that speed, not a correction.
  return { ok: true, stop, percent, snapped: percent !== `${Math.round(h / 100)}%` };
}
