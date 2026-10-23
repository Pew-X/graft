import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveRoll } from "../../../components/LiveRoll.tsx";
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
  const chain = await read((await params).id).catch(() => null);
  if (!chain) return { title: copy.notFound.title, robots: { index: false } };
  const { title, description } = previewOf(chain);
  return { title, description, openGraph: { title, description, type: "website" } };
}

export default async function ChainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chain = await read(id);
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
