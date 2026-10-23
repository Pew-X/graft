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
    lead: "a sound has a past.",
    meta: "stage {n} of {total} · {meta}",
    metaShort: "stage {n} of {total}",
    kicker: "no. {n} · {kind}",
    kickerYours: "no. {n} · yours",
    label: "the credits",
    stage: "stage {n} of {total}: {title}",
  },
  record: {
    label: "the record",
    needle: "drag the needle.",
    value: "stage {n} of {total}, {title}, {at} of {length} seconds",
  },
  states: {
    no_longer_here: "this sound is no longer here, but its credit is.",
    held: "held: a stage it was built on is being looked at for rights, so this one is not served for now. its credit stays.",
    unavailable: "this stage could not be read. the chain still names it.",
    takedown:
      "new requests for it are refused and issued links expire. copies already downloaded cannot be recalled.",
    truncated: "the chain goes back further than this page follows.",
    summaryOne: "one stage cannot be played here. its credit stays.",
    summaryMany: "{n} stages cannot be played here. their credits stay.",
    flippedNone: "not flipped yet",
    flippedOnce: "flipped once",
    flippedMany: "flipped {n} times",
  },
  notFound: {
    title: "nothing here",
    line: "this link does not lead to a sound. it may have been mistyped.",
    home: "go to the first roll",
  },
  failed: {
    title: "the roll could not be read",
    line: "the service did not answer. nothing is lost; try again.",
    retry: "try again",
  },
  admin: {
    title: "operator",
    secret: "operator secret",
    open: "open",
    lock: "lock",
    refresh: "refresh",
    refused: "that was not accepted. wait a little before trying again.",
    unreachable: "the service did not answer. try again.",
    reports: "reports",
    noReports: "no reports.",
    filed: "filed {when}",
    note: "note",
    noNote: "no note",
    openChain: "open the chain",
    state: {
      visible: "visible",
      withdrawn: "hidden: withdrawn",
      rights: "hidden: rights",
    },
    hideWithdrawn: "hide: withdrawn",
    hideRights: "hide: rights",
    lift: "lift the hide",
    switches: "switches",
    publishing: "publishing",
    isOpen: "open",
    isClosed: "closed",
    closePublishing: "close publishing",
    openPublishing: "open publishing",
    uploads: "uploads",
    on: "on",
    off: "off",
    uploadsNote: "set when the service starts. it is read here and not changed here.",
    events: "events by hour",
    eventsNote:
      "client events are best-effort counts of sessions, one session being one page load. the service's own events are exact.",
    hour: "hour",
    noEvents: "no events in this window.",
    relay: "waiting to be delivered: {n}. oldest: {age}.",
    lag: "waiting to be counted: {n}. oldest: {age}.",
  },
  offline: "you look to be offline. the sounds will load when you are back.",
  retry: "try again",
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
