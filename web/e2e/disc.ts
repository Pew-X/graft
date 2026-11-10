/** Where things are on the record, for the browser tests: the same layout the page draws with. */
import type { Page } from "@playwright/test";
import { bandOuter, layout, needleAt } from "../lib/record/disc.ts";

/** A point on the record: stage slot `band`, `u` of the way through it (0 outer edge, 1 inner), nudged `drift` pixels outward. */
export async function pointOn(
  page: Page,
  stages: number,
  band: number,
  u: number,
  drift = 0,
): Promise<{ x: number; y: number }> {
  const size = page.viewportSize()!;
  const l = layout(size.width, size.height, stages);
  const p = needleAt(l, band, u);
  // Outward is away from the centre, along the line the needle moves on.
  return l.portrait ? { x: p.x, y: p.y - drift } : { x: p.x - drift, y: p.y };
}

export { bandOuter, layout };
