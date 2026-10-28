/**
 * The first-visit coach draws on top of the real screen the way a person would with a marker: a loop
 * round the thing to press, an arrow from a note to it. Everything here is plain geometry in pixels, so
 * it can be checked without a browser: the same input always gives the same drawing (a hand-made look
 * that does not shimmer on a resize), and the note is placed where it covers neither the target nor
 * the edge of the screen.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}

/** A small seeded generator (mulberry32): the wobble of a line is fixed by its seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * A loop round `target`, drawn as one wobbling stroke that goes a little more than once round and
 * overshoots where it started, as a marker does. `pad` is the room left between the target and the line.
 */
export function loopPath(target: Rect, pad: number, seed: number): string {
  const rand = seeded(seed);
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  // a superellipse so a wide button gets a wide loop, not a circle through its ends
  const rx = target.w / 2 + pad;
  const ry = target.h / 2 + pad;
  const turns = 1.14;
  const steps = 64;
  const start = rand() * Math.PI * 2;
  const tilt = (rand() - 0.5) * 0.12;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (i / steps) * turns * Math.PI * 2;
    // the second pass runs slightly outside the first, which is what makes it look drawn
    const drift = 1 + (i / steps) * 0.07 + (rand() - 0.5) * 0.025;
    const x = Math.cos(t) * rx * drift;
    const y = Math.sin(t) * ry * drift;
    const px = cx + x * Math.cos(tilt) - y * Math.sin(tilt);
    const py = cy + x * Math.sin(tilt) + y * Math.cos(tilt);
    points.push(`${i === 0 ? "M" : "L"}${fmt(px)} ${fmt(py)}`);
  }
  return points.join(" ");
}

/** A curved arrow from `from` to `to`: the shaft, and the two strokes of the head. */
export function arrowPath(from: Point, to: Point, seed: number): { shaft: string; head: string } {
  const rand = seeded(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  // bend the shaft to one side, by a share of its length
  const bend = (0.16 + rand() * 0.1) * length * (rand() < 0.5 ? -1 : 1);
  const mx = from.x + dx / 2 - (dy / length) * bend;
  const my = from.y + dy / 2 + (dx / length) * bend;
  const shaft = `M${fmt(from.x)} ${fmt(from.y)} Q${fmt(mx)} ${fmt(my)} ${fmt(to.x)} ${fmt(to.y)}`;
  // the head follows the direction the shaft is travelling as it arrives
  const angle = Math.atan2(to.y - my, to.x - mx);
  const size = Math.min(22, Math.max(12, length * 0.2));
  const spread = 0.5 + (rand() - 0.5) * 0.12;
  const left = {
    x: to.x - Math.cos(angle - spread) * size,
    y: to.y - Math.sin(angle - spread) * size,
  };
  const right = {
    x: to.x - Math.cos(angle + spread) * size,
    y: to.y - Math.sin(angle + spread) * size,
  };
  const head = `M${fmt(left.x)} ${fmt(left.y)} L${fmt(to.x)} ${fmt(to.y)} L${fmt(right.x)} ${fmt(right.y)}`;
  return { shaft, head };
}

/**
 * A hand-drawn underline under something `width` pixels wide: one wobbling stroke from the left to
 * the right, a little lower at one end, as a marker does. Drawn on a box of height 12, with the line
 * at about the middle.
 */
export function underlinePath(width: number, seed: number): string {
  const rand = seeded(seed);
  const points: string[] = [];
  const steps = Math.max(6, Math.round(width / 24));
  const slope = (rand() - 0.5) * 3;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const y = 6 + slope * (i / steps - 0.5) + (rand() - 0.5) * 1.6;
    points.push(`${i === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`);
  }
  return points.join(" ");
}

export type Side = "above" | "below" | "left" | "right";

/**
 * Where to put a note of size `card` so that it covers neither `target` (with `air` around it) nor the
 * screen's edge: on the sides in the order of `prefer` (by default above, below, left, right), then any
 * side left. When nowhere fits it goes to the
 * bottom of the screen, clamped, and the arrow is long. Returns the note's top left and the side used.
 */
export function placeCard(
  target: Rect,
  card: { w: number; h: number },
  view: { w: number; h: number },
  margin = 16,
  air = 28,
  prefer: readonly Side[] = ["above", "below", "left", "right"],
): { x: number; y: number; side: Side | "fallback" } {
  const clampX = (x: number): number => Math.max(margin, Math.min(view.w - card.w - margin, x));
  const clampY = (y: number): number => Math.max(margin, Math.min(view.h - card.h - margin, y));
  const centred = target.x + target.w / 2 - card.w / 2;
  const middled = target.y + target.h / 2 - card.h / 2;
  const all: Record<Side, { x: number; y: number; side: Side }> = {
    above: { x: clampX(centred), y: target.y - air - card.h, side: "above" },
    below: { x: clampX(centred), y: target.y + target.h + air, side: "below" },
    left: { x: target.x - air - card.w, y: clampY(middled), side: "left" },
    right: { x: target.x + target.w + air, y: clampY(middled), side: "right" },
  };
  // the caller's preference first, then the other sides in the usual order
  const order: Side[] = [...new Set<Side>([...prefer, "above", "below", "left", "right"])];
  const candidates = order.map((side) => all[side]);
  // each candidate lies outside the target by construction (a note's own edge is `air` from it), so
  // the only thing to ask is whether it also fits on the screen
  for (const c of candidates) {
    const inside =
      c.x >= margin &&
      c.y >= margin &&
      c.x + card.w <= view.w - margin &&
      c.y + card.h <= view.h - margin;
    if (inside) return c;
  }
  return { x: clampX(centred), y: clampY(view.h - card.h - margin * 4), side: "fallback" };
}

/** The point on `target`'s edge nearest `from`, where an arrow should end (a little short of it). */
export function edgeToward(target: Rect, from: Point, gap = 6): Point {
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: target.y - gap };
  // scale the direction until it meets the rectangle's edge, then step out by `gap`
  const sx = dx === 0 ? Infinity : target.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : target.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  const len = Math.hypot(dx, dy);
  return { x: cx + dx * s + (dx / len) * gap, y: cy + dy * s + (dy / len) * gap };
}
