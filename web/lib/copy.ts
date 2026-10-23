/**
 * Every string a visitor reads, in one place, in the voice of the piece: short, lowercase by default,
 * no exclamation marks, credit lines like title cards. Placeholders are written `{name}` and filled
 * with `fill`. A test walks this object, so a word the project does not use cannot get in unnoticed.
 */

export const copy = {
  site: {
    name: "graft",
    line: "a sound's ancestry, rolled as credits.",
    description: "A sound's ancestry, rolled as playable credits.",
  },
  hint: {
    locked: "tap play to hear it. nothing sounds until you do.",
    order: "the finished flip plays first, then the credits go back to the source.",
    loading: "loading the sounds.",
    loadFailed: "the sounds could not be loaded. reload to try again.",
    soundFailed: "the sound could not start. tap play to try again.",
    noAudio: "this browser cannot play the sounds. the credits below still read in full.",
  },
  controls: {
    label: "playback",
    play: "play",
    pause: "pause",
    next: "next stage",
    previous: "previous stage",
    playStage: "play this stage",
    pauseStage: "pause this stage",
    playAll: "play all",
  },
  roll: {
    label: "the credits",
    stage: "stage {n} of {total}: {title}",
    stageButton: "{n}. {title}",
    current: "now playing",
  },
  record: {
    label: "the record",
    needle: "drag the needle.",
    value: "stage {n} of {total}, {title}, {at} of {length} seconds",
    empty: "the roll ends on you. no sound here yet.",
    hover: "{n}. {title}",
  },
  flip: {
    label: "flip this",
    closed: "making a flip is not open yet.",
  },
  end: {
    role: "flipped by",
    gloss: "the roll ends on you. the next flip goes here.",
    value: "maker unknown",
  },
  state: {
    declared: "declared",
    computed: "computed",
    unknown: "unknown",
    asTyped: "as typed",
  },
  details: {
    summary: "details",
  },
  theme: {
    label: "theme",
    system: "system",
    light: "light",
    dark: "dark",
  },
  footer: {
    disclaimer: "independent experiment, not affiliated with or endorsed by any product named.",
    about: "about",
  },
} as const;

/** Fill `{name}` placeholders. A placeholder with no value is left as written, so the gap is visible. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/** The role word on a credit line and a plain gloss for it. */
export const roles: Record<string, { word: string; gloss: string }> = {
  source: { word: "source", gloss: "the sound it began as" },
  flip: { word: "flip", gloss: "what was done to it" },
  "flipped by": { word: "flipped by", gloss: "who made this stage, as typed" },
  by: { word: "by", gloss: "who made it, as typed" },
  "forked from": { word: "forked from", gloss: "the stage this one was cut from" },
  licence: { word: "licence", gloss: "the terms it was shared under, as typed" },
  declaration: { word: "declaration", gloss: "what the maker said about sharing it" },
  rights: { word: "rights", gloss: "whether the right to share it is established" },
  cut: { word: "the cut", gloss: "the part that was kept" },
  speed: { word: "speed", gloss: "how fast it was played back" },
  renderer: { word: "renderer", gloss: "the program that made the audio" },
};

/** Labels for the details layer. */
export const detailLabels = {
  cut: "the cut",
  speed: "speed",
  renderer: "renderer",
  length: "length",
  stage: "stage id",
  record: "record id",
  audio: "audio hash (sha-256)",
} as const;
