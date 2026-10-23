/**
 * The record on the screen: where the disc sits, how wide each slot is, where the needle is for a
 * stage and a place in it, and which slot and place a pointer is over. A slot is a stage (the source
 * outermost, then one empty slot for "the roll ends on you"); inside a slot time runs inward, outer
 * edge first, as on a real record where the track spirals in. The disc is large and bleeds off the
 * screen: off the right edge in landscape, off the bottom in portrait. All plain numbers in pixels.
 */

export interface DiscLayout {
  portrait: boolean;
  /** Radius of the disc. */
  R: number;
  /** Centre of the disc, in pixels from the top left. */
  cx: number;
  cy: number;
  /** Radius of the outermost groove, and of the label. */
  Ro: number;
  Ri: number;
  /** Space between slots, and the width of a slot. */
  gap: number;
  slotW: number;
  /** Where the tonearm is pivoted. */
  pivot: { x: number; y: number };
  /** One per stage, plus the empty slot. */
  slots: number;
}

/** How far past a slot's edge the pointer must go to leave it, as a share of a slot and its gap. */
const HYSTERESIS = 0.25;

export function layout(width: number, height: number, stages: number): DiscLayout {
  const slots = stages + 1;
  const portrait = width < height * 0.9;
  const R = portrait ? Math.min(width * 0.9, height * 0.42) : Math.min(height * 0.68, width * 0.46);
  const cx = portrait ? width / 2 : width + R * 0.04;
  const cy = portrait ? height + R * 0.1 : height / 2;
  const Ro = R * 0.95;
  const Ri = R * 0.26;
  const gap = R * 0.014;
  const slotW = (Ro - Ri - (slots - 1) * gap) / slots;
  const pivot = portrait ? { x: width - 26, y: cy - R - 14 } : { x: width - 44, y: 104 };
  return { portrait, R, cx, cy, Ro, Ri, gap, slotW, pivot, slots };
}

/** Radius of a slot's outer edge. */
export const bandOuter = (l: DiscLayout, slot: number): number => l.Ro - slot * (l.slotW + l.gap);

/** Where the needle is for a place `u` (0 to 1, outer edge to inner) in a slot. */
export function needleAt(l: DiscLayout, slot: number, u: number): { x: number; y: number } {
  const r = bandOuter(l, slot) - u * l.slotW;
  return l.portrait ? { x: l.cx, y: l.cy - r } : { x: l.cx - r, y: l.cy };
}

/**
 * The slot and place under a point. With no slot held yet, a point outside the disc or inside the
 * label is nothing. While dragging, `held` is the slot so far: the pointer may leave the disc and the
 * slot holds, and it changes only once the pointer is a quarter of a slot past its edge, so a pointer
 * shaking on an edge does not flicker between stages.
 */
export function hit(
  l: DiscLayout,
  x: number,
  y: number,
  held: number | null,
): { band: number; u: number } | null {
  const r = Math.hypot(x - l.cx, y - l.cy);
  if (held === null && (r > l.R || r < l.Ri * 0.8)) return null;
  const pitch = l.slotW + l.gap;
  let band: number;
  const within =
    held !== null &&
    r <= bandOuter(l, held) + HYSTERESIS * pitch &&
    r >= bandOuter(l, held) - l.slotW - HYSTERESIS * pitch;
  if (held !== null && (within || r > l.R || r < l.Ri * 0.8)) {
    band = held;
  } else {
    band = Math.min(l.slots - 1, Math.max(0, Math.floor((l.Ro - r) / pitch)));
  }
  const u = Math.min(1, Math.max(0, (bandOuter(l, band) - r) / l.slotW));
  return { band, u };
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
