/**
 * The arithmetic of the recording scope: an X-Y oscilloscope, drawn while the microphone is open. In X-Y
 * mode the sound drives both axes (time is not the horizontal one), which is how a stereo pair draws the
 * glowing loops and knots of a vintage tape machine on a tube. One microphone is one signal, so its second
 * axis is itself a moment earlier (a delay-coordinate plot). The delay follows the sound: it is the first
 * zero of the signal's autocorrelation (the smallest delay that makes the two axes independent), which for a
 * steady tone is a quarter of its period, so the tone draws a circle, and for a voice moves as the pitch
 * does. The size of the figure follows the loudness against a slow memory of how loud the sound has been, so
 * a whisper is small, the usual level is about half the screen and a swell fills more. Nothing here draws or
 * touches audio: it is the part that can be checked by hand.
 */

/** The default delay, until a sound gives a better one: a quarter of the period of a 200 Hz voice. */
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

/** The shortest and longest delay looked for, in samples at 48 kHz (0.125 ms to 6 ms: pitches from about 40 Hz up). */
const SHORTEST = 6;
const LONGEST = 288;

/**
 * The delay that suits this sound, in samples (a fraction): the first lag at which its autocorrelation falls
 * to zero, found by walking the lags and interpolating between the two either side of the crossing. For a
 * steady tone that is a quarter of its period. `null` when there is nothing to say (silence, too few samples,
 * no crossing within a few milliseconds): the caller then keeps the delay it had.
 */
export function tunedDelay(samples: Float32Array, rate: number): number | null {
  const scale = rate / 48_000;
  const shortest = Math.max(2, Math.round(SHORTEST * scale));
  const longest = Math.round(LONGEST * scale);
  const n = samples.length;
  if (n < longest * 2) return null;
  // a slice that is not a whole number of cycles biases the crossing; tapering its ends (a Hann window) removes most of it
  const w = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = (samples[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    w[i] = v;
    energy += v * v;
  }
  if (energy < 1e-6 * n) return null;
  const span = n - longest;
  const r = (lag: number): number => {
    let sum = 0;
    for (let i = 0; i < span; i++) sum += (w[i] ?? 0) * (w[i + lag] ?? 0);
    return sum;
  };
  let previous = r(shortest - 1);
  // the signal must be positively correlated with itself at the start, or "falling to zero" means nothing
  if (!(previous > 0)) return null;
  for (let lag = shortest; lag <= longest; lag++) {
    const here = r(lag);
    if (here <= 0) {
      const t = previous / (previous - here);
      return lag - 1 + t;
    }
    previous = here;
  }
  return null;
}

/**
 * The next delay on the way from `current` to `target`: a few samples at most a frame, so a change of
 * pitch turns the figure smoothly and does not make it jump.
 */
export function slewDelay(current: number, target: number): number {
  const step = Math.max(1, Math.round(current * 0.05));
  if (Math.abs(target - current) <= step) return Math.round(target);
  return current + Math.sign(target - current) * step;
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

/** The quietest the loudness memory goes: below it is the room's hiss, which must not be blown up into a picture. */
const FLOOR = 0.01;
/** The share of the screen's half-width a sound at its usual level is drawn at. */
const USUAL = 0.5;
const MAX_GAIN = 50;

/**
 * The memory of how loud the sound has been, moved on by one frame: it follows a louder sound
 * over a few tenths of a second (so one pop or one clap does not blind it) and forgets a loud one over a
 * couple of seconds, so loudness shows as size against what is usual for this sound, and a hiss never counts
 * as a voice.
 */
export function nextReference(reference: number, peak: number): number {
  const next = peak > reference ? reference + (peak - reference) * 0.06 : reference * 0.992;
  return Math.max(FLOOR, next);
}

/** The gain that draws a sound at its reference level at `USUAL` of the screen's half-width. */
export function gainFor(reference: number): number {
  return Math.min(MAX_GAIN, USUAL / Math.max(FLOOR, reference));
}
