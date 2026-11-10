"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { makeAddress } from "../lib/record/mark.ts";
import { useHoldsFlips } from "../lib/publish/use-kept.ts";
import { staticLoader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
import { RollPlayer } from "./RollPlayer.tsx";

/** The home page's roll: the audio is static files that shipped with the page. */
export function HomeRoll({
  blocks,
  reportTo,
  apiUrl,
}: {
  blocks: readonly Block[];
  reportTo?: string | undefined;
  apiUrl?: string | undefined;
}) {
  const load = useMemo(() => staticLoader(blocks.map((b) => b.audioPath)), [blocks]);
  const router = useRouter();
  const holds = useHoldsFlips();
  return (
    <RollPlayer
      makeHref="/make"
      flipsHref={holds ? "/flips" : undefined}
      blocks={blocks}
      load={load}
      reportTo={reportTo}
      apiUrl={apiUrl}
      openMake={(id, cut, speed) => router.push(makeAddress(id, cut, speed))}
    />
  );
}
