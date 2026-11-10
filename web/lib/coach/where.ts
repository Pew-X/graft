/**
 * Where the first play's caption sits so that it never lies on the record: in landscape the record is
 * the big disc bleeding off the right edge, so the caption stays in the empty space on the left; in
 * portrait the disc bleeds off the bottom, so the caption sits on the screen just above its top edge.
 * Plain numbers in pixels, worked from the same layout the record is drawn with.
 */
import { layout } from "../record/disc.ts";

export interface CaptionBox {
  /** Landscape: the caption is left-aligned this far from the left edge. Portrait: centred (null). */
  left: number | null;
  /** The gap between the bottom of the caption and the bottom of the screen. */
  bottom: number;
  /** The widest the caption may be. */
  maxWidth: number;
}

/** The air between a caption and the edge of the record. */
const AIR = 24;
/** The caption's normal distance from the bottom: the same as the status pill it replaces. */
const REST = 84;

export function captionBox(width: number, height: number, stages: number): CaptionBox {
  const l = layout(width, height, Math.max(1, stages));
  if (!l.portrait) {
    const left = 22;
    return { left, bottom: REST, maxWidth: Math.max(180, Math.min(720, l.cx - l.R - AIR - left)) };
  }
  // the top of the disc is at cy - R; the caption's bottom edge rests AIR above it, but never lower than the pill's place
  const bottom = Math.max(REST, height - (l.cy - l.R) + AIR / 2);
  return { left: null, bottom, maxWidth: Math.min(560, width - 32) };
}
