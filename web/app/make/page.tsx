import type { Metadata } from "next";
import { Make } from "../../components/Make.tsx";
import { apiUrls } from "../../lib/api/server.ts";
import { copy } from "../../lib/copy.ts";
import { soundsFrom, type Shipped } from "../../lib/make/sounds.ts";
import chain from "../../snapshot/chain.json";
import sources from "../../snapshot/sources.json";

export const metadata: Metadata = {
  title: copy.make.title,
  description: copy.site.description,
  robots: { index: false },
};

// A link names what to start from; it is read when the request arrives, so the page is dynamic.
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined): string | null =>
  typeof value === "string" ? value : null;

export default async function MakePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const { curated, flips } = soundsFrom(chain as Shipped, sources as Shipped);
  return (
    <main>
      <Make
        curated={curated}
        flips={flips}
        from={one(query["from"])}
        start={{ cut: one(query["cut"]), speed: one(query["speed"]) }}
        apiUrl={apiUrls().browser}
      />
    </main>
  );
}
