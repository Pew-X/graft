/**
 * The record's geometry, as plain numbers in a disc 100 across from the middle (the component scales
 * it). One band per stage, source outermost, then one empty band for "the roll ends on you". The
 * position along a band is time: one turn of the groove is the stage's whole output. The stylus snaps
 * to a band and stays there until the pointer has gone a quarter of a band past the edge.
 */

/** Radius of the disc. */
export const RADIUS = 100;
/** Radius of the centre label. */
export const HOLE = 22;
/** How far a groove wobbles outwards at full scale, as a share of its band's thickness. */
export const WOBBLE = 0.35;
/** How far past a band's edge the pointer must go to change band, as a share of the thickness. */
const HYSTERESIS = 0.25;

export interface Layout {
  radius: number;
  hole: number;
  /** One per stage, plus the empty slot. */
  bands: number;
  thickness: number;
}

export function layout(stages: number, radius = RADIUS, hole = HOLE): Layout {
  const bands = stages + 1;
  return { radius, hole, bands, thickness: (radius - hole) / bands };
}

export function bandRadii(l: Layout, band: number): { outer: number; inner: number; mid: number } {
  const outer = l.radius - band * l.thickness;
  const inner = outer - l.thickness;
  return { outer, inner, mid: (outer + inner) / 2 };
}

/**
 * The band under a point at distance `r` from the middle. With no band yet (`previous` null) a point
 * outside the disc or inside the label is no band. While dragging, `previous` is the band held so
 * far: the pointer may leave the disc and the band holds, and it changes only once the pointer is a
 * quarter of a band past the edge, so a pointer shaking on an edge does not flicker between stages.
 */
export function bandAt(l: Layout, r: number, previous: number | null): number | null {
  if (previous === null && (r < l.hole || r > l.radius)) return null;
  const clamped = Math.min(l.radius, Math.max(l.hole, r));
  if (previous !== null) {
    const { outer, inner } = bandRadii(l, previous);
    const slack = l.thickness * HYSTERESIS;
    if (clamped <= outer + slack && clamped >= inner - slack) return previous;
  }
  return Math.min(l.bands - 1, Math.floor((l.radius - clamped) / l.thickness));
}

/** Angle of a point from the middle, clockwise from twelve o'clock, in [0, 2π). */
export function angleOf(x: number, y: number): number {
  const a = Math.atan2(x, -y);
  return a < 0 ? a + 2 * Math.PI : a;
}

/** Seconds into a stage of `seconds` at a given angle: a full turn is the whole stage. */
export function offsetAt(angle: number, seconds: number): number {
  return (angle / (2 * Math.PI)) * seconds;
}

/** The angle that is `offset` seconds into a stage of `seconds`; past either end it rests at the end. */
export function angleFor(offset: number, seconds: number): number {
  if (!(seconds > 0)) return 0;
  return (Math.min(seconds, Math.max(0, offset)) / seconds) * 2 * Math.PI;
}

/** The loudest sample in each of `bins` equal slices, as a fraction of full scale (0 to 1). */
export function peaksOf(pcm: Int16Array, bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  for (let i = 0; i < bins; i++) {
    const from = Math.floor((i * pcm.length) / bins);
    const to = Math.floor(((i + 1) * pcm.length) / bins);
    let loudest = 0;
    for (let j = from; j < to; j++) loudest = Math.max(loudest, Math.abs(pcm[j] ?? 0));
    out[i] = loudest / 32768;
  }
  return out;
}

/** How far the stylus pushes the groove under it, as a share of the band's thickness at full strength. */
const PUSH = 0.3;
/** How far round the groove the push reaches either side of the stylus, in radians. */
const PUSH_REACH = 0.35;

/**
 * Points of a stage's groove: on its band's middle, pushed outwards by the wobble of the peaks, and,
 * where the stylus is, pushed a little further so the groove gives way under it.
 */
export function groovePoints(
  l: Layout,
  band: number,
  peaks: readonly number[],
  push?: { angle: number; strength: number },
): Array<[number, number]> {
  const { mid } = bandRadii(l, band);
  return peaks.map((peak, i) => {
    const angle = (i / peaks.length) * 2 * Math.PI;
    let r = mid + peak * l.thickness * WOBBLE;
    if (push) {
      const apart = Math.abs(
        Math.atan2(Math.sin(angle - push.angle), Math.cos(angle - push.angle)),
      );
      r += l.thickness * PUSH * push.strength * Math.max(0, 1 - apart / PUSH_REACH);
    }
    return [r * Math.sin(angle), -r * Math.cos(angle)];
  });
}
