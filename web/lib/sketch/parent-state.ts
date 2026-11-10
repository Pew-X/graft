import type { Shown } from "../manage/read.ts";
import { copy } from "../copy.ts";

/**
 * Why a flip of this published stage could not be published now, from the public read of it, or null
 * when it can. `null` for the read itself means there is no such publication.
 */
export function whyNotPublishable(shown: Shown | null): string | null {
  const c = copy.sketch.cannot;
  if (shown === null) return c.missing;
  if (shown.state === "held") return c.held;
  if (shown.state !== "available") return c.withdrawn;
  if (shown.forkPermitted === false) return c.closed;
  return null;
}
