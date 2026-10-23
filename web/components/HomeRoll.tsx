"use client";

import { useMemo } from "react";
import { staticLoader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
import { RollPlayer } from "./RollPlayer.tsx";

/** The home page's roll: the audio is static files that shipped with the page. */
export function HomeRoll({ blocks }: { blocks: readonly Block[] }) {
  const load = useMemo(() => staticLoader(blocks.map((b) => b.audioPath)), [blocks]);
  return <RollPlayer blocks={blocks} load={load} />;
}
