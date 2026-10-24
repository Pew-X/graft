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
    how1: "press play. the finished flip plays first, then the credits go back to the source.",
    how2: "drag the needle to jump to a step. to make your own, press make a flip.",
    how2Plain: "drag the needle to jump to a step.",
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
    makeLink: "make a flip",
    closed: "making a flip is not open yet.",
    unavailable: "this stage is not here, so it cannot be flipped.",
  },
  publish: {
    open: "publish this flip",
    heading: "publish",
    public: "what you publish is public. anyone with the link can hear it and flip it.",
    noAccount:
      "there is no account. when it is published you get a ticket with a key on it, once: keep it if you may want to close the flip or withdraw it. a published flip cannot be edited; to change it, flip it again.",
    title: "title",
    titleGloss: "up to 60 characters, shown as typed",
    name: "your name",
    nameGloss: "up to 32 characters, shown as typed. not a handle, and it links nowhere.",
    submit: "publish",
    cancel: "keep editing",
    publishing: "publishing.",
    trying:
      "trying again, {n} of {of}. the same request is sent each time, so nothing is made twice.",
    hints: {
      empty: "this is empty, or only a link or a handle, which are removed.",
      tooLong: "{over} characters too many. the limit is {max}.",
      character: "{character} is not allowed here.",
      adjusted: "links and @handles are removed from public text.",
    },
    adjusted: "a link or a handle was removed from your {fields}.",
    gaveUp: {
      network:
        "the network did not answer after {attempts} tries. nothing was lost: try again and the same request goes out.",
      busy: "the service is busy and did not finish after {attempts} tries. nothing was changed: try again and the same request goes out.",
      server:
        "the service did not finish after {attempts} tries. nothing was changed: try again and the same request goes out.",
    },
    retry: "try again",
    fresh: "start a fresh attempt",
    offline: "you look to be offline.",
    refusals: {
      uploadsOff:
        "uploading your own sounds is switched off for now. you can still flip the sounds that are here.",
      publishingOff:
        "publishing is switched off for now. your flip is still here: you can keep making and try again later.",
      storageFull:
        "graft has reached the storage it keeps for sounds, so nothing new can be published for now. try again later.",
      rateLimited: "you have published a lot in a short time. try again {when}.",
      publishCap:
        "everyone together has published as much as is allowed for now. try again {when}.",
      forkCap: "this stage has been flipped as often as is allowed this hour. try again {when}.",
      forkClosed: "the maker of this stage has closed it to new flips.",
      depthCap: "this chain is as long as chains can be, so it cannot hold another stage.",
      parentHeld:
        "this stage is held while its rights are looked at, so nothing can be built on it for now.",
      parentGone: "the stage you were flipping is no longer here, so this cannot be published.",
      conflict:
        "this attempt was already used for a different flip. start a fresh attempt to publish this one.",
      internal:
        "something went wrong on our side. nothing was published. try again and the same request goes out.",
      invalid: "the {field} breaks a rule: {rule}.",
    },
    rules: {
      empty: "it is empty",
      too_long: "it is too long",
      character: "it has a character that is not allowed",
      mixed_scripts: "a word mixes letters from different scripts",
      denied_word: "it uses a word that is not allowed",
      silent: "it is silent",
      constant: "it is one flat tone with no change in it",
      clipped: "it is clipped flat at full volume",
      too_short: "it is too short",
      odd_length: "it is not whole 16-bit audio",
      encoding: "it could not be read as audio",
      required: "it is missing",
      statement: "it is not the statement that was shown",
      basis: "the basis is not one that is offered",
    },
    fields: { title: "title", author: "name", audio: "sound", declaration: "declaration" },
    when: {
      soon: "in a moment",
      seconds: "in about {n} seconds",
      minutes: "in about {n} minutes",
      hour: "in about an hour",
      hours: "in about {n} hours",
    },
    done: {
      heading: "published",
      link: "the link to your flip",
      open: "open it",
      copy: "copy the link",
      copied: "copied.",
      copyFailed: "copying did not work here. select the link and copy it.",
      keyHeading: "your ticket for this flip",
      traceLabel: "a line drawn from this flip's id",
      traceCaption:
        "this line is drawn from the flip's id: the same flip always draws the same line.",
      stubHand: "keep this.",
      keyOnce:
        "it is shown once and cannot be shown again. you need it to close this flip to new flips, or to withdraw it.",
      keyIsNot:
        "it is not a login and not who you are. if you lose it, the only loss is that this flip's settings cannot be changed.",
      copyKey: "copy the key",
      keyCopied: "key copied.",
      keyCopyFailed: "copying did not work here. select the key and copy it.",
      fixed:
        "a published flip is fixed. to change it, flip it again: that makes a new stage after it and leaves this one as it was.",
      keep: "keep this key in this browser",
      keepGloss: "optional. graft keeps it here only because you chose to.",
      kept: "kept in this browser.",
      keepFailed: "this browser would not store it. copy the key somewhere safe instead.",
      mismatch:
        "what was stored is the service's render, which differs from the preview you heard. yours was not stored.",
      replay: "this flip was already published by an earlier try. nothing was made twice.",
      manage: "manage this publication",
    },
  },
  report: {
    open: "report this sound",
    heading: "report this sound",
    about: "you are reporting {title}.",
    categoryLabel: "what is wrong",
    categories: {
      rights: "the right to share it is in doubt",
      private_conversation: "it holds a private conversation",
      harmful: "it is harmful",
      spam: "it is spam",
      other: "something else",
    },
    noteLabel: "a note, if you want to add one",
    noteGloss: "up to 500 characters. only the operator reads it.",
    noContact: "no account, no name and no contact details are asked for or kept with a report.",
    send: "send the report",
    cancel: "close",
    sending: "sending.",
    sent: "the report was received.",
    next: "the operator reads it. if the sound breaks the rules, or the right to share it is in doubt, it is hidden and stays in its chain as no longer here. you will not hear back, because graft keeps no way to reach you.",
    done: "done",
    rateLimited: "you have sent a lot of reports in a short time. try again {when}.",
    gone: "that sound is no longer here, so there is nothing to report.",
    invalid: "the note breaks a rule: {rule}.",
    unreachable: "the report could not be sent. nothing was lost: try again in a moment.",
  },
  manage: {
    title: "manage a publication",
    intro:
      "the manage key you were shown when you published opens two controls for that one publication, and nothing else.",
    keyLabel: "manage key",
    keyGloss:
      "it is sent with each action and is not kept unless you chose to keep it in this browser.",
    useKept: "use the key kept in this browser",
    forgetKept: "forget the key kept in this browser",
    forgotten: "forgotten. this browser no longer holds the key.",
    publication: "the publication",
    forksOpen: "open to new flips",
    forksClosed: "closed to new flips",
    withdrawnNow: "withdrawn: it shows as no longer here and its audio is not served",
    close: "close it to new flips",
    closeEffect:
      "stops only new flips of this stage. flips already made, and the rolls they are in, stay as they are.",
    reopen: "open it to new flips again",
    reopenEffect: "lets people flip this stage again.",
    withdraw: "withdraw it",
    withdrawEffect:
      "leaves the credit in every chain as no longer here and stops serving its audio. the stages built on it keep playing. you cannot undo this; only the operator can.",
    confirm: "yes, withdraw it",
    back: "not now",
    refused: "that key was not accepted.",
    busy: "the service was busy. nothing was changed. try again.",
    unreachable: "the service could not be reached. nothing was changed. try again.",
    loading: "looking for the publication.",
    notFound: "there is no publication with this link.",
    needKey: "enter the manage key to use these controls.",
    manageLink: "manage this publication",
    closedDone: "closed to new flips.",
    reopenedDone: "open to new flips again.",
    withdrawnDone: "withdrawn.",
  },
  about: {
    title: "about graft",
    what: {
      heading: "what graft is",
      body: "a lineage player with a small flip tool. every sound here began as a source and was cut and sped up or slowed down, flip by flip. the roll plays the credits back from the newest flip to the source, so you can hear where a sound came from.",
    },
    isNot: {
      heading: "what it is not",
      body: "not a sampler: one cut and one speed, with no pads, layers, effects or export. an independent experiment, not affiliated with or endorsed by any product named.",
    },
    states: {
      heading: "declared, computed, unknown",
      declared:
        "declared: a person said it and graft prints it as typed: a title, a name, a licence line, a statement about the right to share. graft keeps the words and does not check them.",
      computed:
        "computed: the system produced it and can produce it again: the cut in frames, the speed as a fraction, the length, the hash of the audio, the renderer's name. reproducible is claimed only for the named renderer version and the published test vectors.",
      unknown:
        "unknown: nothing establishes it. that is the default for who really made a sound and whether they hold the right to share it, so those lines say unknown or not established.",
    },
    privacy: {
      heading: "privacy, in plain words",
      claims: {
        session:
          "a visit gets an anonymous session id that lives in memory only. it is never written to your browser and is gone when the page closes.",
        signal:
          "if your browser sends global privacy control or do not track, graft sends no events at all and does not load its error tracker.",
        noIp: "graft stores no ip address in its own records. the hosting providers it runs on have to process addresses to deliver traffic, as any host does.",
        tracker:
          "where error tracking is switched on, it runs without ip addresses, without session replay and with a scrubber.",
        browser:
          "the only things graft can keep in your browser are your choice of light or dark, a note that you have seen the first-visit guide, and a manage key if you tick the box to keep one when you publish.",
      },
    },
    takedown: {
      heading: "taking a sound down",
      claims: {
        report: "anyone can report a sound from the roll, without an account.",
        hidden:
          "a sound that is hidden or withdrawn stays in its chain as no longer here, with its credit. its audio is no longer served and new requests for it are refused.",
        rights:
          "when a sound is hidden because the right to share it is in doubt, the stages built on it are held too, with their credits.",
        expire: "addresses already issued for a sound's audio expire on their own.",
        copies: "a copy that someone already downloaded cannot be recalled.",
      },
    },
    licences: {
      heading: "the sounds made for graft",
      body: "each is declared as {licence}. there is nothing third-party in them. the declaration is printed as typed and is not checked.",
    },
    footerNote: "the independence line is in the footer of every page.",
  },
  own: {
    heading: "your own sound",
    gloss: "stays on this device until you publish it",
    record: "record with the microphone",
    stop: "stop recording",
    recording: "recording. it stops by itself at 15 seconds.",
    pick: "pick an audio file",
    working: "reading the sound.",
    denied:
      "the microphone was not allowed. the sounds made for graft work without it, and you can pick a file instead.",
    unavailable:
      "this browser has no microphone it can use. the sounds made for graft work without it, and you can pick a file instead.",
    tooBig: "that file is too large. the limit is 30 megabytes.",
    unreadable: "that file could not be read as audio. try a wav, mp3, m4a or ogg file.",
    empty: "that file holds no sound.",
    channels:
      "that file has more than two channels, which graft does not read. a mono or stereo file will work.",
    tooLongToTrim: "that recording is over two minutes, too long to trim here. pick a shorter one.",
    trimHeading: "pick the part to keep",
    trimGloss: "a source is at most 15 seconds. the rest is left out.",
    trimUse: "use this part",
    trimTooLong: "that part is too long. a source is at most {max} frames, 15 seconds.",
    trimWhy: "why this part cannot be used",
    honesty:
      "what is published is the sound as your browser read it, worked out here and shown to you. graft cannot tell whether a recording is what you say it is, and the same compressed file can come out slightly different in another browser.",
    flipNote:
      "you are working on your own sound. cut and flip it here; to publish a flip of it, publish the sound first.",
    title: "your sound",
    publishSource: "publish your sound",
    sourceHeading: "publish your sound",
    sourcePublic: "publishing your sound makes it public, and anyone can flip it.",
    basis: "what you are saying",
    basisOwn: "i made this sound",
    basisRight: "i have the right to share it",
    confirm: "i confirm: {statement}",
    declared:
      "this is printed with your sound as declared, as you wrote it. graft does not check it.",
    offUpFront:
      "publishing your own sound is switched off in this demo. you can still record or pick a sound and try it here: it stays on this device. the sounds below can be flipped and published.",
    off: "uploading your own sounds is switched off for now. your sound stays here: you can keep cutting and flipping it, and flip the sounds that are here.",
    closed: "publishing is switched off for now. nothing can be published until it is back.",
    sourceDone: "your sound is published. you can now publish the flip you made from it.",
  },
  make: {
    title: "make a flip",
    kicker: "make a flip",
    home: "← graft",
    intro:
      "a flip is a sound with a part cut out and its speed changed. pick a sound, or record your own, then cut it, change its speed and hear it. you can publish it to get a link to share.",
    steps: {
      label: "steps",
      pick: "pick a sound",
      cut: "cut it and change its speed",
      publish: "publish it, if you like",
    },
    local: "nothing leaves this device until you publish.",
    pick: {
      heading: "pick a sound to start from",
      curated: "sounds made for graft",
      flips: "flips from the roll",
      by: "by {author}",
      choose: "flip this sound",
      change: "pick another sound",
      loading: "loading the sound.",
      failed: "the sound could not be loaded.",
      gone: "that sound is no longer here, so it cannot be flipped.",
    },
    renderer: {
      loading: "getting the renderer ready.",
      failed: "the renderer could not be loaded. reload to try again.",
    },
    cut: {
      label: "the cut",
      gloss: "the part of the sound that is kept",
      start: "start of the cut",
      end: "end of the cut",
      help: "drag the two brackets, or focus one and use the arrow keys: one millisecond a press, ten with shift.",
      tag: { start: "start", end: "end" },
      range: "{from} to {to} seconds, {length} kept",
    },
    speed: {
      label: "speed",
      gloss: "how fast it is played back. faster is higher, slower is lower.",
      slower: "slower",
      faster: "faster",
      approximate: "about {interval}",
      value: "{percent}, {interval}",
    },
    result: {
      label: "what you hear",
      comesOut: "comes out {length} seconds long",
      updating: "the sound is being worked out again. wait a moment, then publish.",
      hash: "hash of what you hear",
      hashGloss: "worked out here, and checked against the service's own when you publish",
    },
    hear: { play: "hear it", pause: "pause", why: "why you cannot hear it yet" },
    refusals: {
      cutShort: "the cut is too short. it needs at least {min} frames, about 10 milliseconds.",
      cutLong: "the cut is too long. it can be at most {max} frames, 10 seconds.",
      cutInverted: "the cut ends before it starts. move the end handle to the right of the start.",
      cutOutside: "the cut reaches outside the sound. pull the handles back inside it.",
      speedRange: "that speed is out of range. it has to be between a quarter and four times.",
      speedTerms: "that speed cannot be sent. pick another.",
      outputShort:
        "this flip would come out too short, under {min} frames. cut a longer part or play it slower.",
      outputLong:
        "this flip would come out too long, over {max} frames, 20 seconds. cut less or play it faster.",
    },
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
    how: "how it works",
  },
  /** Marking a part of a stage on the record, to flip just that part. */
  mark: {
    toggle: "cut on the record",
    stop: "stop cutting",
    drag: "drag along a ring to mark the part you want. on a keyboard, press [ and ] on the record.",
    flipPart: "flip this part",
    clear: "clear",
    seconds: "{n} s",
  },
  /** The first-visit coach: three short notes, drawn over the real screen, shown once. */
  coach: {
    label: "how it works",
    count: "{n} of {total}",
    next: "next",
    back: "back",
    skip: "skip",
    done: "start listening",
    play: {
      title: "press play.",
      body: "you hear the finished flip first. then the credits go back, stage by stage, to the sound it began as.",
    },
    needle: {
      title: "drag the needle.",
      body: "the record is the whole chain: one ring for each stage, the first one outermost. put the needle anywhere to hear that moment.",
    },
    make: {
      title: "make your own.",
      body: "pick a stage, cut a part of it, change its speed and hear it. you can mark the part right on the record. publish it and the chain grows by one.",
    },
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
