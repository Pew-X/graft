"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { staticLoader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
import { RollPlayer } from "./RollPlayer.tsx";

/** The home page's roll: the audio is static files that shipped with the page. */
export function HomeRoll({
  blocks,
  reportTo,
}: {
  blocks: readonly Block[];
  reportTo?: string | undefined;
}) {
  const load = useMemo(() => staticLoader(blocks.map((b) => b.audioPath)), [blocks]);
  const router = useRouter();
  return (
    <RollPlayer
      blocks={blocks}
      load={load}
      reportTo={reportTo}
      openMake={(id) => router.push(`/make?from=${encodeURIComponent(id)}`)}
    />
  );
}
