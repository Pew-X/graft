/**
 * A chain read from the service, as credit blocks. Only what is public and stable goes into a block:
 * never an audio address (those are short-lived and are fetched separately, in the browser), so a
 * page rendered on the server cannot leak the address of a hidden or held stage.
 */
import { copy, fill } from "../copy.ts";
import type { Chain, Entry } from "../api/chain.ts";
import { blockFor, faceLines, type Block, type StageInput } from "./view.ts";

type Available = Extract<Entry, { state: "available" }>;

function flippedText(count: number): string {
  if (count === 0) return copy.states.flippedNone;
  if (count === 1) return copy.states.flippedOnce;
  return fill(copy.states.flippedMany, { n: count });
}

function inputFrom(stage: Available): StageInput {
  return {
    id: stage.id,
    kind: stage.kind,
    title: stage.title,
    lines: stage.lines,
    record_id: stage.details.record_id,
    output_blob: stage.details.output_blob,
    cut_start: stage.details.cut.start,
    cut_end: stage.details.cut.end,
    speed_p: stage.details.speed?.p ?? null,
    speed_q: stage.details.speed?.q ?? null,
    renderer: `${stage.details.renderer.name} ${stage.details.renderer.version}`,
    frames: null,
    audio_path: null,
  };
}

export function blocksFromChain(chain: Chain): Block[] {
  return chain.stages.map((entry, index): Block => {
    switch (entry.state) {
      case "available":
        return blockFor(inputFrom(entry), index, flippedText(entry.flipped_count));
      case "no_longer_here":
      case "held":
        return {
          id: entry.id,
          lettering: "src",
          meta: "",
          cutFrames: null,
          state: entry.state,
          flipped: null,
          index,
          numeral: String(index + 1),
          title: entry.title,
          kind: entry.kind,
          dye: (index % 4) as 0 | 1 | 2 | 3,
          seconds: 0,
          audioPath: null,
          face: faceLines(entry.lines),
          details: [],
        };
      case "unavailable":
        return {
          id: entry.id,
          lettering: "src",
          meta: "",
          cutFrames: null,
          state: "unavailable",
          flipped: null,
          index,
          numeral: String(index + 1),
          title: "unavailable",
          kind: "unknown",
          dye: (index % 4) as 0 | 1 | 2 | 3,
          seconds: 0,
          audioPath: null,
          face: [],
          details: [],
        };
    }
  });
}
