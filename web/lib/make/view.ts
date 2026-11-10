/**
 * The window of the sound the waveform shows. Zoom is an editing aid for placing the brackets
 * precisely: the brackets themselves always hold frames of the WHOLE sound, so a zoomed view never
 * changes what a cut means. A view is a half-open range of frames [from, to). Pure.
 */

export interface View {
  from: number;
  to: number;
}

/** The narrowest window: a few hundred frames, about 10 ms, enough to place a bracket by single frames. */
export const MIN_SPAN = 480;

export const wholeView = (total: number): View => ({ from: 0, to: Math.max(0, total) });

export const isWhole = (view: View, total: number): boolean => view.from <= 0 && view.to >= total;

/** Keep a window inside the sound and at least MIN_SPAN wide (or the whole sound if that is shorter). */
export function clampView(view: View, total: number): View {
  if (total <= MIN_SPAN) return wholeView(total);
  const span = Math.max(MIN_SPAN, Math.min(total, view.to - view.from));
  const from = Math.max(0, Math.min(total - span, view.from));
  return { from: Math.round(from), to: Math.round(from + span) };
}

/**
 * Zoom by `factor` (above 1 zooms in) keeping the frame under the cursor where it is on screen:
 * `anchor` is that frame, so the same fraction of the window sits left of it before and after.
 */
export function zoomAt(view: View, total: number, anchor: number, factor: number): View {
  if (!(factor > 0) || !Number.isFinite(factor)) return clampView(view, total);
  const span = view.to - view.from;
  const next = Math.max(MIN_SPAN, Math.min(total, span / factor));
  const fraction = span <= 0 ? 0.5 : (anchor - view.from) / span;
  const from = anchor - fraction * next;
  return clampView({ from, to: from + next }, total);
}

/** Slide the window by `delta` frames, stopping at the ends of the sound. */
export function panBy(view: View, total: number, delta: number): View {
  return clampView({ from: view.from + delta, to: view.to + delta }, total);
}

/** The window that shows a stretch with a margin around it (a zoom to the cut): a fifth each side. */
export function viewAround(start: number, end: number, total: number): View {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const margin = Math.max(MIN_SPAN, Math.round((hi - lo) / 5));
  return clampView({ from: lo - margin, to: hi + margin }, total);
}

/** The frame under a pointer at `x` on a track at `left`, `width` wide, showing `view`. */
export function frameInView(x: number, left: number, width: number, view: View): number {
  if (width <= 0) return Math.round(view.from);
  const fraction = Math.max(0, Math.min(1, (x - left) / width));
  return Math.round(view.from + fraction * (view.to - view.from));
}

/** Where a frame sits in the window as a fraction (below 0 or above 1 when it is out of view). */
export function fractionOf(frame: number, view: View): number {
  const span = view.to - view.from;
  return span <= 0 ? 0 : (frame - view.from) / span;
}

/** The factor one wheel notch zooms by, from the wheel's delta (so a trackpad's small steps are small). */
export function wheelFactor(deltaY: number): number {
  const clamped = Math.max(-240, Math.min(240, deltaY));
  return Math.exp(-clamped / 240);
}

/** The factor a pinch zooms by, from the distance between the fingers before and now. */
export function pinchFactor(before: number, now: number): number {
  return before > 0 && now > 0 ? now / before : 1;
}
