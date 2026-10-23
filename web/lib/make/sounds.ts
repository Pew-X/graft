/**
 * The sounds a maker can start from, read from the two snapshots that ship with the site: the
 * curated sources (each a root with its declared licence line) and the flips on the home roll. No
 * request is made to read them; their public ids are the ones the service holds.
 */
export interface ShippedLine {
  role: string;
  value: string;
  honesty: string;
}
export interface ShippedStage {
  id: string;
  kind: string;
  title: string;
  author: string;
  lines: ShippedLine[];
  frames: number;
  audio_path: string;
}
export interface Shipped {
  stages: ShippedStage[];
}

export interface Sound {
  id: string;
  kind: "source" | "flip";
  title: string;
  author: string;
  /** The declared licence line as typed, for a source; null for a flip. */
  licence: ShippedLine | null;
  frames: number;
  audioPath: string;
}

export interface Sounds {
  curated: Sound[];
  flips: Sound[];
  find(id: string): Sound | undefined;
}

function sound(stage: ShippedStage): Sound {
  return {
    id: stage.id,
    kind: stage.kind === "flip" ? "flip" : "source",
    title: stage.title,
    author: stage.author,
    licence: stage.lines.find((l) => l.role === "licence") ?? null,
    frames: stage.frames,
    audioPath: stage.audio_path,
  };
}

export function soundsFrom(chain: Shipped, sources: Shipped): Sounds {
  const curated = sources.stages.map(sound);
  const known = new Set(curated.map((s) => s.id));
  const flips = chain.stages.filter((s) => s.kind === "flip" && !known.has(s.id)).map(sound);
  const byId = new Map([...curated, ...flips].map((s) => [s.id, s]));
  return { curated, flips, find: (id) => byId.get(id) };
}
