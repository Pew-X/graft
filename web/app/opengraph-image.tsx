import { ImageResponse } from "next/og";
import { copy, fill } from "../lib/copy.ts";
import { buildBlocks, type StageInput } from "../lib/roll/view.ts";
import { cardAssets } from "../lib/share/assets.ts";
import { Card, SIZE, type CardInput } from "../lib/share/card.tsx";
import snapshot from "../snapshot/chain.json";

export const alt = copy.site.description;
export const size = SIZE;
export const contentType = "image/png";

/** The home page's card: the seeded chain's finished flip, the one the roll opens on. */
export default async function Image() {
  const blocks = buildBlocks(snapshot.stages as StageInput[]);
  const last = blocks.at(-1)!;
  const input: CardInput = {
    id: last.id,
    title: last.title,
    kicker: fill(copy.roll.kicker, { n: String(last.numeral).padStart(2, "0"), kind: last.kind }),
    lettering: last.lettering,
    dye: last.dye,
  };
  const assets = await cardAssets();
  return new ImageResponse(<Card input={input} paper={assets.paper} />, {
    ...size,
    fonts: assets.fonts,
  });
}
