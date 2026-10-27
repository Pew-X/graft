"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { createApi, fetchChain } from "../lib/api/chain.ts";
import { makeAddress } from "../lib/record/mark.ts";
import { liveLoader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
import { RollPlayer } from "./RollPlayer.tsx";

/**
 * A chain read from the service. The page was rendered with the credits; the audio addresses are
 * short-lived and are asked for here, in the browser, when the page opens (and again if one expires).
 */
export function LiveRoll({
  id,
  apiUrl,
  blocks,
  truncated,
}: {
  id: string;
  apiUrl: string;
  blocks: readonly Block[];
  truncated: boolean;
}) {
  const load = useMemo(() => {
    const api = createApi(apiUrl);
    return liveLoader({ chain: () => fetchChain(api, id) });
  }, [apiUrl, id]);
  const router = useRouter();
  return (
    <RollPlayer
      makeHref="/make"
      blocks={blocks}
      load={load}
      truncated={truncated}
      reportTo={`${apiUrl}/v1/events`}
      apiUrl={apiUrl}
      openMake={(sound, cut, speed) => router.push(makeAddress(sound, cut, speed))}
    />
  );
}
