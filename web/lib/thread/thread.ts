/**
 * The thread: a patch cable from a stage's label to its groove on the record. The cable carries the
 * stage's own trace (the line drawn from its public id) as its wobble, so the picture on the label
 * and the line in the cable are one thing. It is drawn, not measured: it says nothing about the sound.
 * All plain numbers in pixels.
 */

export interface Point {
  x: number;
  y: number;
}

/** How far the cable leans out of the label before it bends toward the record, as a share of the span. */
const LEAN = 0.45;

/** A point on the cable's centre line at `t` (0 at the label, 1 at the groove), and its direction. */
export function cableAt(from: Point, to: Point, t: number): { at: Point; dir: Point } {
  const dx = to.x - from.x;
  const c1 = { x: from.x + dx * LEAN, y: from.y };
  const c2 = { x: to.x - dx * LEAN, y: to.y };
  const u = 1 - t;
  const at = {
    x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
    y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
  };
  const d = {
    x: 3 * u * u * (c1.x - from.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (to.x - c2.x),
    y: 3 * u * u * (c1.y - from.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (to.y - c2.y),
  };
  const len = Math.hypot(d.x, d.y) || 1;
  return { at, dir: { x: d.x / len, y: d.y / len } };
}

/**
 * The cable as an SVG path: its centre line, pushed sideways at each point by that value of the trace
 * (values between -1 and 1, at rest at both ends) times `amp` pixels. The two ends are exactly `from`
 * and `to` whenever the trace starts and ends at rest, as a trace always does.
 */
export function threadPath(from: Point, to: Point, values: readonly number[], amp: number): string {
  if (values.length < 2) return "";
  return values
    .map((v, i) => {
      const { at, dir } = cableAt(from, to, i / (values.length - 1));
      const x = at.x - dir.y * v * amp;
      const y = at.y + dir.x * v * amp;
      return `${i === 0 ? "M" : "L"}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}
