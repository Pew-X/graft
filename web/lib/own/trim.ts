/**
 * Choosing 30 seconds out of a long recording. A recording of a few minutes is shown whole; a longer one is
 * shown through a window of a minute that the maker moves along it, because a 30 second part is too small
 * to place on a waveform of thirty minutes. The part kept is worked out in the recording's own frames, so
 * `checkTrim` still decides what may be used.
 */
import { MAX_FRAMES } from "./source.ts";

const RATE = 48_000;

/** The window the brackets work in: one minute. A recording no longer than this is shown whole. */
export const VIEW_FRAMES = 60 * RATE;
/** The window moves a second at a time. */
export const POSITION_STEP = RATE;

/** Whether a recording needs the moving window (it is longer than the window). */
export const needsWindow = (total: number): boolean => total > VIEW_FRAMES;

/** The furthest the window may start, so it always ends inside the recording. */
export const lastPosition = (total: number): number => Math.max(0, total - VIEW_FRAMES);

/** A position from the control, held to whole steps inside the recording. */
export function clampPosition(total: number, position: number): number {
  const stepped = Math.round(position / POSITION_STEP) * POSITION_STEP;
  return Math.min(lastPosition(total), Math.max(0, stepped));
}

/** The frames of the recording the window shows for this position. */
export function windowAt(total: number, position: number): { start: number; end: number } {
  if (!needsWindow(total)) return { start: 0, end: total };
  const start = clampPosition(total, position);
  return { start, end: Math.min(total, start + VIEW_FRAMES) };
}

/** Where the brackets start in a window: its first 30 seconds, or all of it when it is shorter. */
export const startingCut = (windowFrames: number): { start: number; end: number } => ({
  start: 0,
  end: Math.min(windowFrames, MAX_FRAMES),
});

/** A moment as minutes and seconds ("4:17"), or hours too past the hour ("1:02:05"). */
export function clock(frames: number): string {
  const whole = Math.max(0, Math.floor(frames / RATE));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
