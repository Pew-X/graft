/**
 * A twelve-stage chain on the real roll and record, for the tests that need the deepest chain the
 * service allows (13 rings). It is bundled by the test setup and served by the test only; it is not
 * part of the site.
 */
import { createRoot } from "react-dom/client";
import { RollPlayer } from "../components/RollPlayer.tsx";
import { staticLoader } from "../lib/roll/audio.ts";
import { buildBlocks, type StageInput } from "../lib/roll/view.ts";
import snapshot from "../snapshot/chain.json";

const base = snapshot.stages as StageInput[];
const stages: StageInput[] = Array.from({ length: 12 }, (_, i) => {
  const from = base[i % base.length]!;
  return { ...from, id: `long${i}`, title: `${i + 1} ${from.title}` };
});

// The roll without the site around it (no router): the same player the home page uses.
const blocks = buildBlocks(stages);
createRoot(document.getElementById("root")!).render(
  <RollPlayer blocks={blocks} load={staticLoader(blocks.map((b) => b.audioPath))} />,
);
