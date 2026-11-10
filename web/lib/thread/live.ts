/**
 * When the stage on screen is "live": a sound is playing, and it is that stage's. Then its colour goes to
 * the oscilloscope tile, the thread to its ring and the lit groove, so one colour means one live stage. At
 * rest everything goes back to green. The loudness at the playhead drives the thread's brightness, so the
 * line carries something real (the stage's own peaks, which the page already holds for the record).
 */
import type { StageState } from "../roll/view.ts";

export type Dye = 0 | 1 | 2 | 3;

export function liveDye(input: {
  playing: boolean;
  /** The stage that is sounding, or null. */
  current: number | null;
  /** The stage on screen. */
  hero: number;
  state: StageState | undefined;
  dye: Dye | undefined;
}): Dye | null {
  if (!input.playing || input.current === null || input.current !== input.hero) return null;
  if (input.state !== "available" || input.dye === undefined) return null;
  return input.dye;
}

/** The loudest sample of the slice the playhead is in, 0 to 1; silence for anything that cannot be read. */
export function levelAt(peaks: readonly number[], position: number, length: number): number {
  if (peaks.length === 0 || !(length > 0) || !Number.isFinite(position)) return 0;
  const i = Math.min(peaks.length - 1, Math.max(0, Math.floor((position / length) * peaks.length)));
  const v = peaks[i] ?? 0;
  return Math.min(1, Math.max(0, v));
}
