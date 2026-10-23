/**
 * Watches how long each frame lasts and says when the record should stop doing the expensive part of its
 * drawing (the stylus pushing the groove under it) and keep to the cached bands. It judges the
 * median of the last 30 frame gaps, so one long frame (a tab switch, a collection) does not count,
 * and once it has degraded it stays degraded for the visit: a drawing that flaps is worse than a
 * plain one.
 */
const WINDOW = 30;
const MIN_FRAMES = 20;
/** Slower than this a frame at a time is under about 38 frames a second. */
const SLOW_MS = 26;

export class FrameGovernor {
  #last: number | null = null;
  #gaps: number[] = [];
  #degraded = false;

  get degraded(): boolean {
    return this.#degraded;
  }

  /** Call once per animation frame with the frame's timestamp in milliseconds. */
  frame(timestamp: number): void {
    if (this.#last !== null) {
      this.#gaps.push(timestamp - this.#last);
      if (this.#gaps.length > WINDOW) this.#gaps.shift();
      if (!this.#degraded && this.#gaps.length >= MIN_FRAMES) {
        const sorted = [...this.#gaps].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        if (median > SLOW_MS) this.#degraded = true;
      }
    }
    this.#last = timestamp;
  }
}
