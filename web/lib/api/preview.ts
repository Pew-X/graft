import { copy } from "../copy.ts";
import type { Chain } from "./chain.ts";

/**
 * The link preview of a chain: a title and one plain line, and nothing else (no poster, no card, no
 * share template). The title is the final stage's; a final stage that is not here has no title to
 * give, so the preview falls back to the site's own.
 */
export function previewOf(chain: Chain): { title: string; description: string } {
  const last = chain.stages.at(-1);
  const title = last && last.state !== "unavailable" ? last.title : copy.site.name;
  const stages = chain.stages.length;
  const description =
    stages === 1
      ? "a sound, with its credits."
      : `a sound and the ${stages - 1} flip${stages === 2 ? "" : "s"} that came before it, rolled as credits.`;
  return { title, description };
}
