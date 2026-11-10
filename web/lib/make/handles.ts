/** How the cut's handles move. A millisecond is 48 frames. */
const MS = 48;

/** The change in frames a key makes to a focused handle, or null when the key is not for it. */
export function keyStep(key: string, shift: boolean): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return shift ? 10 * MS : MS;
    case "ArrowLeft":
    case "ArrowDown":
      return shift ? -10 * MS : -MS;
    case "PageUp":
      return 100 * MS;
    case "PageDown":
      return -100 * MS;
    default:
      return null;
  }
}

/** Move a handle by `delta` frames, staying inside the sound. It may pass the other handle. */
export function move(frame: number, delta: number, length: number): number {
  return Math.max(0, Math.min(length, frame + delta));
}

/** The frame under a pointer at `x`, on a track starting at `left` that is `width` wide. */
export function frameAt(x: number, left: number, width: number, length: number): number {
  if (width <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, (x - left) / width));
  return Math.round(fraction * length);
}
