import { ImageResponse } from "next/og";
import { createApi, fetchChain, type Chain } from "../../../lib/api/chain.ts";
import { previewOf } from "../../../lib/api/preview.ts";
import { apiUrls } from "../../../lib/api/server.ts";
import { copy, fill } from "../../../lib/copy.ts";
import { ID_SHAPE } from "../../../lib/flips/list.ts";
import { blocksFromChain } from "../../../lib/roll/live.ts";
import { cardAssets } from "../../../lib/share/assets.ts";
import { Card, SIZE, type CardInput } from "../../../lib/share/card.tsx";

export const alt = copy.site.description;
export const size = SIZE;
export const contentType = "image/png";

// A hide or a withdrawal changes what the card may say, and it must say so at once: never cached.
export const dynamic = "force-dynamic";

/** A crawler will not wait for a service that is waking: the card is drawn from the id alone after this long. */
const WAIT_MS = 2_000;

async function chainOrNothing(id: string): Promise<Chain | null | undefined> {
  const read = fetchChain(createApi(apiUrls().server), id).catch(() => undefined);
  const late = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), WAIT_MS));
  return Promise.race([read, late]);
}

/**
 * A flip's card: its title in the lettering and dye its stage has, its own oscilloscope line, and the one
 * plain line the page's own link preview says. A stage that is not here, a chain that is not found, and a
 * service that does not answer in time all give the site's own words and the line the id draws: the card
 * never says more than the page's metadata does.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = ID_SHAPE.test(raw) ? raw : "";
  const chain = id ? await chainOrNothing(id) : undefined;
  let input: CardInput = {
    id: id || "graft",
    title: copy.site.name,
    kicker: "",
    lettering: "src",
    dye: 1,
  };
  if (chain) {
    const preview = previewOf(chain);
    const last = blocksFromChain(chain).at(-1);
    if (last && last.state === "available") {
      input = {
        id: last.id,
        title: preview.title,
        kicker: fill(copy.roll.kicker, {
          n: String(last.numeral).padStart(2, "0"),
          kind: last.kind,
        }),
        lettering: last.lettering,
        dye: last.dye,
      };
    }
  }
  const assets = await cardAssets();
  return new ImageResponse(<Card input={input} paper={assets.paper} />, {
    ...size,
    fonts: assets.fonts,
  });
}
