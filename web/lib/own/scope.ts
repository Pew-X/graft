/**
 * The arithmetic of the recording scope: an X-Y oscilloscope, drawn while the microphone is open. In X-Y
 * mode the sound drives both axes (time is not the horizontal one), which is how a stereo pair draws the
 * glowing loops and knots of a vintage tape machine on a tube. One microphone is one signal, so its second
 * axis is itself a moment earlier (a delay-coordinate plot): a steady tone draws an ellipse, a circle when
 * the delay is a quarter of its period; louder sounds draw bigger loops, a rising pitch turns them faster,
 * and speech draws tangled, living ones. Nothing here draws or touches audio: it is the part that can be
 * checked by hand.
 */

/** The delay of the second axis: a quarter of the period of a 200 Hz voice. */
export const DELAY_MS = 1.25;

/** The delay in whole samples at `rate`, never less than one. */
export function delaySamples(rate: number, ms = DELAY_MS): number {
  if (!(rate > 0)) return 1;
  return Math.max(1, Math.round((rate * ms) / 1000));
}

export interface Point {
  /** -1 to 1 across the screen. */
  x: number;
  /** -1 to 1 up the screen. */
  y: number;
}

const clamp1 = (n: number): number => Math.max(-1, Math.min(1, n));

/**
 * The points the beam visits for a run of samples: x is the sample now, y the sample `delay` samples
 * earlier, both multiplied by `gain` and kept inside the screen. The first `delay` samples have no earlier
 * partner and are not drawn.
 */
export function delayPairs(samples: Float32Array, delay: number, gain: number): Point[] {
  const out: Point[] = [];
  for (let i = delay; i < samples.length; i++) {
    out.push({ x: clamp1((samples[i] ?? 0) * gain), y: clamp1((samples[i - delay] ?? 0) * gain) });
  }
  return out;
}

/**
 * How bright the beam is across a segment that moved `length` pixels in one sample step: full when it
 * barely moves (it dwells there, so the phosphor is hit longest), dimmer the faster it goes, never below a
 * fifth (a transient must still be seen).
 */
export function beamLevel(length: number): number {
  if (!Number.isFinite(length) || length <= 0) return 1;
  const FLOOR = 0.2;
  const REFERENCE = 6;
  return Math.max(FLOOR, Math.min(1, 1 / (1 + length / REFERENCE)));
}

/** The most a quiet sound is opened up, so room noise is not drawn as a roar. */
const MAX_GAIN = 40;
/**
 * The share of the screen's half-width the loudest part is brought to: about half, so the figure is a compact
 * knot in the middle of the tube with room for its glow, as on a real instrument, not a picture that fills it.
 */
const TARGET = 0.5;

/**
 * The next gain from the present gain and the peak just seen (0 to 1 at gain 1): a peak that would leave
 * the screen is cut at once; a quieter sound opens the gain a little at a time.
 */
export function nextGain(gain: number, peak: number): number {
  const wanted = peak > 1e-4 ? Math.min(MAX_GAIN, TARGET / peak) : MAX_GAIN;
  if (wanted < gain) return wanted;
  return Math.min(MAX_GAIN, gain + (wanted - gain) * 0.04);
}

/** What the two axes are, said on the screen, from the real delay. */
export function readout(rate: number): string {
  const ms = (delaySamples(rate) / rate) * 1000;
  return `x: mic now · y: mic ${ms.toFixed(2)} ms ago`;
}
