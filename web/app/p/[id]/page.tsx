import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveRoll } from "../../../components/LiveRoll.tsx";
import { WakingChain } from "../../../components/WakingChain.tsx";
import { createApi, fetchChain } from "../../../lib/api/chain.ts";
import { previewOf } from "../../../lib/api/preview.ts";
import { apiUrls } from "../../../lib/api/server.ts";
import { copy } from "../../../lib/copy.ts";
import { blocksFromChain } from "../../../lib/roll/live.ts";

// A hide or a withdrawal changes what this page may say, and it must say so at once: never cached.
// The page carries credits and states only, never an audio address (those are issued to the browser).
export const dynamic = "force-dynamic";

// A bad id is a quiet empty state, and the error page (not a crash) covers a service that is down.
async function read(id: string) {
  return fetchChain(createApi(apiUrls().server), id);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // a service that did not answer is asleep, not missing: the tab says so, and is not offered to search
  const chain = await read((await params).id).catch(() => undefined);
  if (chain === undefined) return { title: copy.waking.title, robots: { index: false } };
  if (chain === null) return { title: copy.notFound.title, robots: { index: false } };
  const { title, description } = previewOf(chain);
  return { title, description, openGraph: { title, description, type: "website" } };
}

export default async function ChainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A service that did not answer is almost always one that was asleep: say so, and come back by itself.
  const chain = await read(id).catch(() => undefined);
  if (chain === undefined) return <WakingChain apiUrl={apiUrls().browser} />;
  if (chain === null) notFound();
  return (
    <main>
      <LiveRoll
        id={id}
        apiUrl={apiUrls().browser}
        blocks={blocksFromChain(chain)}
        truncated={chain.truncated !== null && chain.truncated !== undefined}
      />
    </main>
  );
}
