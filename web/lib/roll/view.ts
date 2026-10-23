/**
 * From a chain's stages to what the roll shows: one credit block per stage. The face of a block is
 * the credit lines a visitor reads; the details layer is the exact values one level down. Every row
 * carries its honesty state as a word, so no state is left to colour.
 */
import { detailLabels, roles } from "../copy.ts";
import { describeSpeed } from "./speed.ts";

export type Honesty = "declared" | "computed" | "unknown";

/** The shape the roll needs of a stage. The static snapshot has it; the API's stage view maps onto it. */
export interface StageInput {
  id: string;
  kind: string;
  title: string;
  lines: Array<{ role: string; value: string; honesty: string }>;
  record_id: string;
  output_blob: string;
  cut_start: number;
  cut_end: number;
  speed_p: number | null;
  speed_q: number | null;
  renderer: string;
  /** Length of the stage's audio in frames; null when it is not known yet (a chain read from the service). */
  frames: number | null;
  /** Where the stage's audio is; null when it is not served, or not carried with the block. */
  audio_path: string | null;
}

export interface FaceLine {
  role: string;
  /** The role word as printed on the block. */
  word: string;
  gloss: string;
  value: string;
  honesty: Honesty;
  /** The honesty state in words. */
  state: Honesty;
  /** A declared value is what a person typed, and is marked so. */
  asTyped: boolean;
}

export interface DetailRow {
  label: string;
  value: string;
  honesty: Honesty;
  state: Honesty;
  asTyped: boolean;
}

/** What a reader of the chain is told about a stage's availability. */
export type StageState = "available" | "no_longer_here" | "held" | "unavailable";

export interface Block {
  id: string;
  state: StageState;
  /** "flipped 3 times", for a stage that can be heard; null otherwise or when not known. */
  flipped: string | null;
  /** Position in the chain, from 0 at the source. */
  index: number;
  /** 1-based, as printed. */
  numeral: string;
  title: string;
  kind: string;
  /** Which of the four dyes, cycling by stage. */
  dye: 0 | 1 | 2 | 3;
  /** Length of the stage's full output, in seconds. */
  seconds: number;
  audioPath: string | null;
  face: FaceLine[];
  details: DetailRow[];
}

const SAMPLE_RATE = 48_000;
/** Roles that live in the details layer rather than on the face. */
const DETAIL_ROLES = new Set(["cut", "speed", "renderer"]);

function honesty(value: string): Honesty {
  // Anything the server sends that is not one of the three is treated as the weakest claim.
  return value === "declared" || value === "computed" ? value : "unknown";
}

function row(label: string, value: string, state: Honesty): DetailRow {
  return { label, value, honesty: state, state, asTyped: state === "declared" };
}

function details(stage: StageInput): DetailRow[] {
  const rows: DetailRow[] = [
    row(detailLabels.cut, `frames ${stage.cut_start} to ${stage.cut_end}`, "computed"),
  ];
  if (stage.speed_p !== null && stage.speed_q !== null) {
    const speed = describeSpeed(stage.speed_p, stage.speed_q);
    const approx = speed.approximate ? "about " : "";
    rows.push(
      row(
        detailLabels.speed,
        `${stage.speed_p}/${stage.speed_q} · ${speed.percent} · ${approx}${speed.interval}`,
        "computed",
      ),
    );
  }
  rows.push(row(detailLabels.renderer, stage.renderer, "computed"));
  if (stage.frames !== null) {
    rows.push(row(detailLabels.length, `${(stage.frames / SAMPLE_RATE).toFixed(1)} s`, "computed"));
  }
  rows.push(
    row(detailLabels.stage, stage.id, "computed"),
    row(detailLabels.record, stage.record_id, "computed"),
    row(detailLabels.audio, stage.output_blob, "computed"),
  );
  return rows;
}

/** The credit lines of a stage as printed on a block's face (the cut, speed and renderer go one level down). */
export function faceLines(
  lines: ReadonlyArray<{ role: string; value: string; honesty: string }>,
): FaceLine[] {
  return lines
    .filter((line) => !DETAIL_ROLES.has(line.role))
    .map((line): FaceLine => {
      const state = honesty(line.honesty);
      const known = roles[line.role];
      return {
        role: line.role,
        word: known?.word ?? line.role,
        gloss: known?.gloss ?? "",
        value: line.value,
        honesty: state,
        state,
        asTyped: state === "declared",
      };
    });
}

/** A stage that can be heard, as a block. */
export function blockFor(stage: StageInput, index: number, flipped: string | null = null): Block {
  return {
    id: stage.id,
    state: "available",
    flipped,
    index,
    numeral: String(index + 1),
    title: stage.title,
    kind: stage.kind,
    dye: (index % 4) as 0 | 1 | 2 | 3,
    seconds: stage.frames === null ? 0 : stage.frames / SAMPLE_RATE,
    audioPath: stage.audio_path,
    face: faceLines(stage.lines),
    details: details(stage),
  };
}

export function buildBlocks(stages: readonly StageInput[]): Block[] {
  return stages.map((stage, index) => blockFor(stage, index));
}
