/**
 * Every string a visitor reads, in one place, in the voice of the piece: short, lowercase by default,
 * no exclamation marks, credit lines like title cards. Placeholders are written `{name}` and filled
 * with `fill`. A test walks this object, so a word the project does not use cannot get in unnoticed.
 */

/** The pad rule is told in one place: the pads, the keys sheet and the about page all read these. */
const PAD_RULE = {
  single: "cut",
  overlap: "overlap",
  singleSays: "a new pad cuts off the one still sounding.",
  overlapSays: "pads keep sounding together, up to six.",
} as const;

export const copy = {
  site: {
    name: "graft",
    line: "a sound's ancestry, rolled as credits.",
    description: "A sound's ancestry, rolled as playable credits.",
    /** What graft is, in one breath: on the first screen, and in the about page and the README. */
    sentence: "a sound has a past. hear how this one was made, then make the next step.",
  },
  hint: {
    locked: "tap play to hear it. nothing sounds until you do.",
    /** The same, for a first visit: it says what the first play is, in the words of the sentence above it. */
    lockedFirst: "tap to hear how this was made. nothing sounds until you do.",
    loading: "loading the sounds.",
    loadFailed: "the sounds could not be loaded. reload to try again.",
    soundFailed: "the sound could not start. tap play to try again.",
  },
  controls: {
    label: "playback",
    play: "play",
    /** The main button on a first visit: what pressing it does, in the words of the sentence above it. */
    playFirst: "hear how it was made",
    pause: "pause",
    next: "next stage",
    previous: "previous stage",
    playStage: "play this stage",
    pauseStage: "pause this stage",
    playAll: "play all",
  },
  /** Performing the roll: the number keys and the pads play the stages. */
  perform: {
    /** The control in the transport; it is pressed while the keys are on. */
    label: "perform",
    /** The line under the record while performing. */
    hint: "keys 1 to {n} play the stages. escape stops the sound, then leaves.",
    hintFew: "key {n} plays the stage. escape stops the sound, then leaves.",
    /** More stages than keys: the pads play the rest. */
    hintMore:
      "keys 1 to {n} play the first stages; the pads play them all. escape stops the sound, then leaves.",
    /** A press on a stage that cannot play says why, never a silent dead press. */
    unplayable: "stage {n} cannot be played: {why}.",
    preparing: "getting the sound ready. press again.",
    resumed: "the sound was asleep: press again.",
    failed: "the sound could not start. press perform to try again.",
    /** Read out when a stage is played, with its number and title. */
    played: "stage {n} of {total}: {title}",
    /** The bank of pads. */
    bank: "the stages, as pads",
    /** A pad's name for a reader of the screen: the number first, as on the record. */
    pad: "stage {n}, {title}",
    /** Why a pad cannot play, in words (a pad never goes quiet without saying). */
    why: {
      no_longer_here: "no longer here",
      held: "held",
      unavailable: "not read",
      silent: "no sound",
    },
    /** The rule for a press on another pad while something sounds: two names, each with what it does. */
    rule: "when you press another pad",
    ...PAD_RULE,
    stop: "stop",
  },
  /** Sketches: private tries, held in this browser only. */
  sketch: {
    heading: "your sketches",
    intro:
      "a sketch is a try only you can hear. a published flip is public and its sound cannot be changed, so keep as many tries as you like and publish the one you love.",
    where:
      "sketches are kept in this browser only: closing the tab keeps them, and a private window loses them when it closes.",
    noAutosave: "the editor is not saved by itself. press keep as sketch to keep a try.",
    keep: "keep as sketch",
    titleLabel: "name of this try",
    titleGloss: "optional: left empty, it is named from the speed",
    kept: "kept as a sketch: {title}. nothing is published.",
    keptAdjusted:
      "kept as a sketch: {title}. a link or a handle in the title was removed, as it would be when published.",
    noteLabel: "a note",
    noteGloss:
      "optional: a line to remember it by, up to 140 characters. it is sent with the flip if you publish this sketch.",
    noteWhy: {
      empty: "the note is empty once links and handles are removed.",
      too_long: "the note is longer than {limit} characters.",
      character: "the note has a character that is not allowed: {detail}",
      mixed_scripts: "a word in the note mixes letters from different scripts.",
      denied_word: "the word {detail} cannot be used in a note.",
    },
    noteAdd: "add a note",
    noteEdit: "edit the note",
    noteSave: "save the note",
    noteCancel: "cancel",
    noteClear: "remove the note",
    noteEditLabel: "note",
    titleWhy: {
      empty: "the title is empty once links and handles are removed.",
      too_long: "the title is longer than {limit} characters.",
      character: "the title has a character that is not allowed: {detail}",
      mixed_scripts: "a word in the title mixes letters from different scripts.",
      denied_word: "the word {detail} cannot be used in a title.",
    },
    needSource: "publish your sound first: a sketch starts from a published sound.",
    failed: {
      storage:
        "this browser would not keep it. nothing was kept, and the editor is as you left it.",
      newer:
        "this browser holds sketches from a newer version of graft. they are left as they are, and nothing new can be kept here.",
      limit: "this browser keeps at most {max} sketches. discard one to keep another.",
      invalid: "this try could not be kept.",
    },
    offerDiscard: "make room by discarding {title}, the oldest sketch nothing goes on from?",
    open: "open",
    rename: "rename",
    renameSave: "save the name",
    renameLabel: "new title",
    discard: "discard",
    discardAsk: "discard this sketch?",
    discardAskMany: "discard this and the {n} that go on from it?",
    discardYes: "yes, discard",
    discardNo: "keep it",
    discarded: "discarded.",
    discardedOthers: "discarded, with {n} that went on from it.",
    cutLine: "cut {from} to {to} s of the sound it starts from.",
    twin: "same as {title}",
    published: "published",
    openPublished: "open the published flip",
    noFit: "this try no longer fits: {why}",
    elsewhere: "this sketch was discarded in another tab. the editor keeps its values.",
    cannot: {
      prefix: "cannot be published: {why}",
      withdrawn: "the sound it was cut from was withdrawn",
      held: "the sound it was cut from is held",
      closed: "the sound it was cut from is closed to new flips",
      missing: "the sound it was cut from is not found",
    },
    budget: {
      room: "{n} more stages fit after this one.",
      roomOne: "one more stage fits after this one.",
      none: "no more stages fit: the chain is as long as the service allows.",
      checking: "checking how many stages fit.",
      failed: "could not check how many stages fit. the service will tell you when you publish.",
    },
    from: {
      stage: "from stage {n}",
      stageUnknown: "from a published stage",
      sketch: "from sketch '{title}'",
    },
    goOn: "go on from this",
    goOnWhy: "cannot go on from this: {why}",
    another: "keep as another try",
    backTo: "back to sketch '{title}'",
    parentUnpublished:
      "this goes on from a sketch that is not published yet, so it cannot be published alone.",
    compare: {
      marked: "marked {side}",
      group: "compare two sketches",
      playBoth: "play {first} then {second}",
      playOne: "play one: {side}",
      stop: "stop",
      cannotPlay: "{side} cannot be played: {why}",
      reset: "clear {first} and {second}",
    },
    bank: {
      heading: "your sketch bank",
      intro:
        "play your tries together. up to twelve sketches sit on pads. nothing is published and nothing is sent.",
      add: "put on the bank",
      onIt: "on the bank",
      remove: "remove from the bank",
      earlier: "move earlier",
      later: "move later",
      full: "the bank holds at most {max} sketches.",
      empty: "nothing on the bank yet. press put on the bank on a sketch above.",
      preparing: "getting the sound ready",
      long: "this bank holds about {n} seconds of sound. on a phone that is a lot to keep ready, and the page may run short of memory. shorter flips keep it light.",
      keysOff: "number keys: off",
      keysOn: "number keys: on",
      keysWhy:
        "the number keys play the pads only while this is on, so typing a number anywhere else never makes a sound. escape turns it off.",
      once: "one pad is a bank too: it plays that sketch.",
      pads: "the sketches on the bank, as pads",
      pad: "pad {n}, {title}",
      recording: "recording: press the pads. sixteen seconds or sixty-four presses at most.",
      phraseKept:
        "phrase kept: {n} presses, for this visit only. sketches are private, so the link cannot carry it.",
      padRemoved: "this pad was removed from the bank, so it does not sound in the phrase.",
      phraseLocal:
        "a phrase on this bank is kept for this visit only and cannot be sent as a link.",
    },
    set: {
      heading: "publish these",
      choose: "publish this one",
      intro:
        "tick the sketches to publish, then press publish these. they go out in order, and the links and keys end up on one screen.",
      plan: "{n} will be published, in this order:",
      pulledIn:
        "also published, because a sketch you chose goes on from them and they are not published yet: {titles}.",
      leftOut: "at most {max} are sent in one press. {n} wait for the next one.",
      already: "{n} of the sketches you chose are already published and are not published again.",
      author: "your name",
      go: "publish these ({n})",
      running: "publishing {done} of {total}.",
      stop: "stop after this one",
      continue: "continue",
      nothingLost:
        "nothing is lost: what is published stays published, and the rest wait here, in this browser.",
      elsewhere: "this set is being published in another tab.",
      summary: "{published} published, {waiting} waiting.",
      state: {
        waiting: "waiting",
        publishing: "publishing",
        trying: "trying again ({n} of {of})",
        published: "published",
        already: "already published: an earlier try made it, so nothing was made twice",
        skippedParent: "skipped: the sketch it goes on from was not published",
        stopped: "stopped here",
      },
      stoppedBecause: {
        gaveUp: "the service did not answer: {why}. nothing was lost; press continue to try again.",
        mismatch:
          "stopped here. the service made the last flip a little differently from this page, so anything built on it would not match. the rest was not published.",
        render: "this sketch could not be made here: {why}",
        cancelled: "stopped. press continue to go on.",
      },
      keyLost:
        "the service made this flip on an earlier try, and its answer never reached this page, so its key was never shown. this flip cannot be changed or withdrawn from here.",
      keyNotKept:
        "this browser would not keep the key. copy it from here now: it is not shown again.",
      editTitle: "change the title of {title}",
      saveAndContinue: "save and continue",
      result: "published: your links and keys",
      resultIntro:
        "each flip has its own link and its own key. a key is how you withdraw or close a flip later, and it is shown once.",
      showKey: "show key",
      hideKey: "hide key",
      keyLabel: "key for {title}",
      copyKeys: "copy all keys",
      keysCopied: "copied. the keys are plain text: keep them somewhere safe.",
      keysCopyFailed: "the keys could not be copied here. show a key and select it instead.",
      keep: "keep these keys in this browser",
      keepGloss: "so these flips are listed under your flips and you can manage them later",
      forgotten: "forgotten. this browser no longer holds these keys.",
      none: "nothing was chosen.",
      open: "open",
      flipNext: "flip this next",
      leaveWarn:
        "the keys of these flips are not kept in this browser and not copied. they are shown once. press flip this next again to leave anyway.",
    },
    publishedAlready: "this sketch is published, and a published sketch is not published again.",
    empty: "no sketches yet. press keep as sketch after you hear a try you like.",
    move: {
      summary: "move my sketches",
      copyLink: "copy my sketchbook link",
      linkCopied:
        "link copied. this link carries your sketches, and anyone you send it to can read them. it carries no keys and nothing that publishes anything.",
      copyFailed: "the link could not be copied. nothing was changed.",
      longLink:
        "this link is long ({n} characters), and a messenger may cut it short. a file is the safer way.",
      saveFile: "save my sketches to a file",
      fileSaved:
        "saved. the file carries your sketches in plain text, and no keys. anyone who has it can read them.",
      addFile: "add sketches from a file",
      fileBad:
        "that is not a sketchbook file. it is a small text file made by save my sketches, at most 64 kilobytes.",
      nothing: "keep a sketch first: there is nothing to move yet.",
      question: "this carries {what}. add them to this browser?",
      one: "1 sketch",
      many: "{n} sketches",
      moreTitles: "and {n} more",
      yes: "add them",
      no: "not now",
      elsewhere: "this link carries sketches. they are added on the make page.",
      goMake: "open the make page",
      added: "added {n}.",
      already: "{n} were already here.",
      leftOut: "did not fit in the limit of {max}: {titles}.",
      refused: {
        tooLong: "this is too long to be a sketchbook link, so none of it was added.",
        format: "this is not a sketchbook link, so none of it was added.",
        version: "this was made by a newer version of graft and cannot be read here.",
        cutShort:
          "this link looks cut short, so none of it was added. ask for it again, or use a file.",
        checksum: "this link was changed or damaged, so none of it was added.",
        number: "this link has a number that is out of range, so none of it was added.",
        title: "a title in this link breaks the rules for titles, so none of it was added.",
        note: "a note in this link breaks the rules for notes, so none of it was added.",
        parent:
          "a sketch in this link goes on from one that is not in it, so none of it was added.",
        cycle:
          "the sketches in this link go on from each other in a circle, so none of it was added.",
        depth:
          "the sketches in this link go on from each other too many times, so none of it was added.",
        many: "this link carries more than {max} sketches, so none of it was added.",
      },
      storageFailed: "this browser would not keep them. nothing was added.",
      newer: "this browser holds sketches from a newer version of graft, so nothing was added.",
    },
  },
  /** The flips made from a stage, listed under it on a chain page. */
  stageFlips: {
    line: "flips of this stage ({n})",
    label: "the flips of this stage",
    none: "there are no flips of this stage yet.",
    by: "by {author}",
    more: "show more",
    newest:
      "newest first. titles and names are typed by the people who made them, and graft does not check them.",
    failed: "the flips of this stage could not be read. the service may be waking up.",
    moreFailed: "the next flips could not be read. the ones above are still here.",
    tryAgain: "try again",
    bank: {
      open: "play these flips as pads",
      close: "put the pads away",
      heading: "the flips of this stage, as pads",
      honesty:
        "these are other people's flips of this stage. titles and names are shown as typed and are not checked. nothing here publishes anything.",
      newest: "the newest {n} of {total} are on the pads.",
      once: "there is one flip of this stage, so there is one pad.",
      pad: "pad {n}, {title}",
      preparing: "getting the sound ready",
      goneHere: "no longer here",
      held: "held",
      unreadable: "could not be read",
      retry: "try again: {title}",
      keysOff: "number keys: off",
      keysOn: "number keys: on",
      keysWhy:
        "the number keys play the pads only while this is on. escape turns it off. a screen reader keeps the digit keys for itself, so use the pads.",
      recording: "recording: press the pads. sixteen seconds or sixty-four presses at most.",
      phraseKeptLinked:
        "phrase kept: {n} presses. the address of this page carries it, with the flips it was played on.",
      phraseKept:
        "phrase kept: {n} presses, for this visit. this page's link cannot carry it (another address part is in use).",
      padRemoved: "this pad is no longer here, so it does not sound in the phrase.",
      invite: "a run of pads came with this link, on these flips. no sound with it.",
      linkCopied: "link copied. it carries the presses and the ids of the flips, and no sound.",
      linkFailed: "the link could not be copied. the address bar has it.",
    },
  },
  /** A phrase: the presses made in perform, kept in the page's address. */
  phrase: {
    group: "a phrase",
    record: "rec",
    recordStop: "stop rec",
    play: "play phrase",
    /** The visible words on a narrow screen, where one row has to hold five buttons; the buttons keep their full names. */
    playShort: "play",
    copyShort: "link",
    loop: "loop",
    clear: "clear",
    /** Read when a button is hovered or focused: what each of the five does, in plain words. */
    recTitle: "keep the pads you press, up to sixteen seconds",
    playTitle: "play the pads you kept, once",
    loopTitle: "repeat your phrase until you stop it",
    copyTitle: "copy a link to this phrase: it holds the presses and no sound",
    clearTitle: "remove this phrase",
    /** Shown until there is a phrase: the five steps, in order. */
    howTo: "press rec, tap pads, press stop rec, then play.",
    /** Shown once there is one: the words that need a sentence. */
    after: "play runs it once. loop repeats it until you stop it.",
    copy: "copy link",
    recording: "recording: press the pads. sixteen seconds or sixty-four presses at most.",
    empty: "nothing was pressed, so there is no phrase.",
    kept: "phrase kept: {n} presses. the address of this page carries it.",
    removed: "phrase removed.",
    keptNoLink:
      "phrase kept: {n} presses, for this visit. this page's link cannot carry it (a pad past the twelfth, or another address part in use).",
    noLink: "there is no link for this phrase to copy.",
    copied: "link copied. it carries the presses and no sound.",
    copyFailed: "the link could not be copied. the address bar has it.",
    /** The quiet invitation on a page opened from a link that carries a phrase. */
    invite: "a run of pads came with this link. no sound with it.",
    inviteButton: "play the phrase",
    dismiss: "not now",
  },
  roll: {
    meta: "stage {n} of {total} · {meta}",
    metaShort: "stage {n} of {total}",
    kicker: "no. {n} · {kind}",
    kickerYours: "no. {n} · yours",
    label: "the credits",
    stage: "stage {n} of {total}: {title}",
    more: "more",
    moreLabel: "more of this stage",
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
  /** A chain page opened while the service was asleep: said plainly and kindly, and it comes back by itself. */
  waking: {
    title: "waking up.",
    line: "this sound lives on a small server that sleeps when nobody is around. it needs about a minute to wake, and this page opens by itself when it is ready.",
    checking: "checking again in a moment.",
    offline: "you look to be offline. it will check again when you are back.",
    slow: "it is taking longer than a minute. nothing is lost: try now, or come back in a little while.",
    tryNow: "try now",
    home: "hear the first roll meanwhile",
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
    makerNote: "the maker's note: {note}",
    makerNoteChanged:
      "the maker's note, changed after this report was filed (so it may not be what was reported): {note}",
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
      "there is no account. you get a key once, when it is published: keep it if you may want to close the flip or withdraw it. the sound of a published flip cannot be edited; flip it again to change it. only its note can be changed, with the key.",
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
        "the network did not answer after {attempts} tries. the service may be waking up, which needs about a minute. nothing was lost: try again and the same request goes out.",
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
      rateLimited:
        "you have published a lot in a short time. nothing you made is lost, so please try again {when}.",
      publishCap:
        "everyone together has published as much as is allowed for now. nothing you made is lost, so please try again {when}.",
      forkCap:
        "this stage has been flipped as often as is allowed this hour. nothing you made is lost, so please try again {when}.",
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
    fields: {
      title: "title",
      author: "name",
      note: "note",
      audio: "sound",
      declaration: "declaration",
    },
    note: "a note",
    noteGloss:
      "optional: up to 140 characters, shown as typed under the title. you can change it later with the key.",
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
      /** The one line that says what was published and where it sits in the lineage. */
      namedSource: "the source: {title}",
      namedFlip: "stage {n}: {title}",
      namedFlipFrom: "stage {n}: {title}, made from {parent}",
      /** The link line for a sound of one's own (the source), which is not a flip. */
      linkSource: "the link to your sound",
      /** An older published panel, folded to one line once a newer stage stands on it. */
      folded: "published",
      foldedNote: "built on below",
      /** What the next-stage button is for, said once, beside the newest published stage. */
      nextNote: "the next flip is made from this one, so the lineage grows by one.",
      /** The main button: the next stage is made from this one, in this tab. */
      next: "flip this next",
      /** Shown when the key is neither kept in this browser nor copied and "flip this next" is pressed. */
      leaveWarn:
        "the key for this flip is not kept in this browser and not copied. it is shown once. press again to leave anyway.",
      open: "open it in a new tab",
      copy: "copy the link",
      copied: "copied.",
      copyFailed: "copying did not work here. select the link and copy it.",
      keyHeading: "your ticket for this flip",
      traceLabel: "a line drawn from this flip's id",
      traceCaption:
        "this line is drawn from the flip's id: the same flip always draws the same line.",
      stubHand: "keep this.",
      keyWhat:
        "the link above is what you share. this ticket is only for you: it is how you withdraw this flip later, or close it to new flips.",
      keyOnce: "it is shown once and cannot be shown again, so copy it now.",
      keyIsNot:
        "it is not a login and not who you are. if you lose it, the only loss is that this flip's settings cannot be changed.",
      copyKey: "copy the key",
      keyCopied: "key copied.",
      keyCopyFailed: "copying did not work here. select the key and copy it.",
      fixed:
        "a published flip's sound is fixed. to change it, flip it again: that makes a new stage after it and leaves this one as it was. its note is the one thing you can still change.",
      keep: "keep this key in this browser",
      keepGloss:
        "so this flip is listed under your flips and you can manage it later. untick it to forget the key now.",
      kept: "kept in this browser.",
      forgotten: "forgotten. copy the key now: it is shown only once.",
      flips: "your flips",
      keepFailed: "this browser would not store it. copy the key somewhere safe instead.",
      mismatch:
        "what was stored is the service's render, which differs from the preview you heard. yours was not stored.",
      replay: "this flip was already published by an earlier try. nothing was made twice.",
      manage: "manage this publication",
    },
  },
  /** The page that lists the flips this browser holds a key for. */
  flips: {
    title: "your flips",
    intro:
      "the flips you published from this browser. graft has no account: this list is only the manage key of each flip, kept in this browser.",
    here: "forgetting a key here removes it from this browser. it does not withdraw the flip.",
    empty:
      "no flips here yet. a flip you publish is listed here, in the browser you published it from.",
    make: "make a flip",
    loading: "looking for your flips.",
    open: "open",
    manage: "manage",
    forget: "forget",
    forgetAsk:
      "forget this key? you will not be able to close, withdraw or change the note of this flip from here again. the flip stays published.",
    forgetYes: "yes, forget it",
    forgetNo: "keep it",
    forgottenOne: "forgotten.",
    states: {
      open: "open to new flips",
      closed: "closed to new flips",
      withdrawn: "withdrawn",
      missing: "not found: it may have been removed",
      checking: "checking.",
      unreachable: "the service is not answering. it may be waking up.",
    },
    retry: "try again",
    older: "{n} older flips are also kept in this browser.",
    untitled: "a flip",
    /** On each row: where this flip sits. */
    kindSource: "source",
    stageOf: "stage {n}",
    madeFrom: "made from {parent}",
    /** A heading over the flips that belong to one source, when there is more than one. */
    lineageOf: "lineage of {title}",
    /** Your own flips played as pads, across every lineage you made, in lineage order. */
    pads: {
      open: "play your flips as pads",
      heading: "your flips, as pads",
      honesty:
        "your own flips, source first within each lineage, up to twelve. nothing is mixed or published: pads play one at a time or together, and rec keeps the order you press them.",
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
      "the manage key you were shown when you published opens three controls for that one publication: its note, whether it is open to new flips, and withdrawing it. nothing else.",
    keyLabel: "manage key",
    keyGloss:
      "it is sent with each action. this browser keeps it only if the keep box was ticked when you published.",
    flips: "your flips",
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
    note: {
      heading: "the note",
      gloss:
        "one short line under the title, in your own words. you can change or remove it whenever you like. the sound stays exactly as it is.",
      label: "note",
      save: "save the note",
      clear: "remove the note",
      saved: "the note is saved.",
      savedAdjusted: "the note is saved. a link or a handle was removed, as it is in titles.",
      removed: "the note is removed.",
      locked: "this publication is withdrawn, so its note is left as it was.",
      limited: "too many changes just now. wait a little and try again.",
      closed: "publishing is switched off for now, so notes cannot be changed. try again later.",
      invalid: "the note breaks a rule: {rule}.",
      none: "there is no note yet.",
    },
  },
  about: {
    title: "about graft",
    what: {
      heading: "what graft is",
      body: "every sound here began as one recording. people cut a piece of it and changed its speed, again and again. you can hear each step, and make the next one.",
    },
    /** A way back to the guided first play, for anyone who wants it again. */
    tour: {
      heading: "see it played again",
      body: "the roll plays itself once, with a few words on the screen. you can have that again from the start, as often as you like.",
      link: "play the guide again",
    },
    /** The keys and the pads: what perform is, and the page that lists every key. */
    perform: {
      heading: "playing it",
      body: `turn on perform and the number keys play the stages of a chain: 1 to 9, 0, minus and equal are stages 1 to 12, by where the key is, so any keyboard works. every stage is also a pad you can touch. a press plays that stage whole, and nothing is cut or changed. two rules decide what a press on another pad does: ${PAD_RULE.single} (${PAD_RULE.singleSays.replace(/\.$/, "")}) and ${PAD_RULE.overlap} (${PAD_RULE.overlapSays.replace(/\.$/, "")}).`,
      phrase:
        "rec keeps your presses as a phrase: which pad, and when, up to sixteen seconds. play runs it again, once, and loop repeats it until you stop it. the phrase lives in the address of the page, so copying the link sends it. it holds no sound and no name; a link you open only offers it, and it plays when you press play.",
      keys: "the keys button lists every keyboard control of the page you are on. a screen reader keeps the digit keys for itself, so the pads are plain buttons.",
    },
    /** Own sounds are switched on or off by the service, so the page says it with a condition. */
    own: {
      heading: "your own sound",
      body: "when own sounds are switched on, the make page can start from your own recording or an audio file of up to thirty minutes, and you pick up to 30 seconds of it to keep. the microphone asks your browser for permission first. the sound stays on your device until you publish it, and what is published is the sound as your browser read it. publish only sounds you made or may share: graft cannot check that for you.",
    },
    whatItIs: {
      heading: "what a flip is",
      body: "a flip is one cut and one speed of one parent sound, and every pad plays exactly that, with its lineage kept. an independent experiment, not affiliated with or endorsed by any product named.",
      /** The same, for a build that holds perform back. */
      bodyWithoutPerform:
        "a flip is one cut and one speed of one parent sound, with its lineage kept. an independent experiment, not affiliated with or endorsed by any product named.",
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
        wake: "opening graft may start its service if it was asleep: your browser asks graft's own server, which sends one short call with nothing about you in it.",
        noIp: "graft stores no ip address in its own records. the hosting providers it runs on have to process addresses to deliver traffic, as any host does.",
        tracker:
          "where error tracking is switched on, it runs without ip addresses, without session replay and with a scrubber.",
        browser:
          "the only things graft can keep in your browser are your choice of light or dark, a note of how far you have got with the first-visit guide and the make-a-flip hints (a short word each), the manage key of each flip you publish from it, so that your flips can be listed here, and your sketches (the tries you keep before you publish anything) with the choice of which to publish next. sketches never leave your browser unless you publish them. you can untick the box when you publish, forget a key on the your flips page, or discard any sketch.",
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
    recording: "recording. it stops by itself at 30 seconds.",
    pick: "pick an audio file",
    working: "reading the sound.",
    denied:
      "the microphone was not allowed. the sounds made for graft work without it, and you can pick a file instead.",
    unavailable:
      "this browser has no microphone it can use. the sounds made for graft work without it, and you can pick a file instead.",
    tooBig:
      "that file is too large. the limit is 150 megabytes. a thirty minute recording fits as mp3 or m4a, not as wav.",
    unreadable: "that file could not be read as audio. try a wav, mp3, m4a or ogg file.",
    empty: "that file holds no sound.",
    channels:
      "that file has more than two channels, which graft does not read. a mono or stereo file will work.",
    tooLongToTrim:
      "that recording is over thirty minutes, too long to read here. pick a shorter one.",
    trimHeading: "pick the part to keep",
    trimLong:
      "this recording is {total} long. move along it to find the moment, then place the brackets in the minute shown.",
    trimWhere: "where in the recording",
    trimWhereValue: "{at} of {total}",
    trimHear: "hear this part",
    trimStopHear: "stop",
    trimGloss: "a source is at most 30 seconds. the rest is left out.",
    trimUse: "use this part",
    trimTooLong: "that part is too long. a source is at most {max} frames, 30 seconds.",
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
    rightsNote: "publish only sounds you made or may share; graft cannot check that for you.",
    moreSummary: "more about recordings",
    reportNote:
      "anyone can report a sound, and a sound that is reported can be hidden, with the flips built on it held while it is looked at.",
    sourceDone: "your sound is published. you can now publish the flip you made from it.",
    /** Once a flip of the sound is published: what is next. */
    flipDone:
      "published. to build on it, press flip this next under the newest stage: it makes the next stage from that one.",
  },
  /** The idea of graft in five plain steps: shown on the make page, and again on the about page. */
  how: {
    heading: "how graft works",
    lead: "graft lets you hear where a sound came from, and add the next step yourself.",
    steps: [
      {
        name: "a flip",
        body: "a flip is a piece of a sound played faster or slower. that is all it does.",
      },
      {
        name: "a lineage",
        body: "every flip remembers the sound it came from. follow that back and you have its lineage: each sound, who made it, and what it was made from. the record on the first page plays one.",
      },
      {
        name: "publishing",
        body: "publishing adds your flip to the lineage, where anyone can hear it and flip it again. its sound, cut and speed cannot be changed afterwards. its note can.",
      },
      {
        name: "sketches",
        body: "so try first. a sketch is a try only you can hear. keep as many as you like, play them side by side on pads, then publish the one you love.",
      },
      {
        name: "your key",
        body: "when you publish you get a key. it is the only way to close, withdraw or add a note to that flip later, and graft has no accounts, so keep it.",
      },
    ],
    own: "have a recording of your own? add it here, pick up to 30 seconds of it, and it starts a new lineage.",
    open: "show how graft works",
    close: "hide how graft works",
  },
  make: {
    title: "make a flip",
    kicker: "make a flip",
    home: "← graft",
    steps: {
      label: "steps",
      pick: "pick",
      cut: "cut and speed",
      publish: "share",
    },
    local: "nothing leaves this device until you publish.",
    /** What a flip is, in one line, above the editor. */
    one: "a flip is one cut and one speed of one sound.",
    /** One line at a time above the editor, each gone when the visitor does the thing it says. */
    guide: {
      pick: "pick a sound, or record your own. you cut a piece of it next.",
      hear: "this flip plays higher, a fifth up. press hear it.",
      change: "now move a bracket or the speed, and hear it change.",
      /** A second, smaller line under the change hint: what the keyboard does to a bracket. */
      changeKeys: "arrow keys nudge a bracket; shift nudges it ten times more.",
      keep: "keep a try as a sketch. a published flip is permanent; a sketch is not.",
      another: "try another, or press go on from this on a sketch.",
      pads: "put two sketches on the bank, then touch their pads.",
      publish: "tick the ones worth keeping and press publish these.",
      next: "after a flip is published, press flip this next.",
      skip: "skip",
      show: "show me",
      how: "how it works",
      label: "a short guide to making a flip",
    },
    /** Where this flip will sit, said at the top of the editor so a maker never has to guess. */
    lineage: {
      ownUnpublished:
        "you are cutting your own recording. publish it first: it becomes stage 1, and the flip you make from it stage 2.",
      ownPublished:
        "you are cutting your recording, stage 1: {title}. the flip you publish here is stage 2.",
      fromStage: "making stage {n}, from {parent}.",
      fromStageUnknown: "making the next stage, from {parent}.",
    },
    pick: {
      heading: "pick a sound to start from",
      curated: "sounds made for graft",
      flips: "flips from the roll",
      own: "your flips",
      ownOlder: "{n} older flips are also kept in this browser.",
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
      gloss: "drag the brackets to keep a piece",
      start: "start of the cut",
      end: "end of the cut",
      help: "or click a bracket and use the arrow keys: one millisecond a press, ten with shift.",
      tag: { start: "start", end: "end" },
      range: "{from} to {to} seconds, {length} kept",
      playhead: "where the sound is playing now",
      zoom: {
        toggle: "zoom",
        gloss: "look closer to place a bracket exactly. the brackets still hold the whole sound.",
        in: "zoom in",
        out: "zoom out",
        fit: "fit the cut",
        whole: "whole sound",
        hint: "scroll or pinch to zoom around the pointer. hold shift and scroll to slide.",
        showing: "showing {from} to {to} seconds.",
        offscreen: "out of view",
      },
    },
    speed: {
      label: "speed",
      gloss: "faster is higher, slower is lower",
      slower: "slower",
      faster: "faster",
      approximate: "about {interval}",
      value: "{percent}, {interval}",
      typed: {
        label: "or type a speed",
        unit: "percent",
        set: "set",
        snapped: "snapped to {percent}, the nearest speed there is",
        exact: "set to {percent}",
        empty: "type a number between 25 and 400",
        number: "that is not a number. use digits, like 150",
        range: "speeds go from 25 to 400 percent",
      },
    },
    result: {
      label: "what you hear",
      comesOut: "comes out {length} seconds long",
      updating: "the sound is being worked out again. wait a moment, then publish.",
      hash: "hash of what you hear",
      hashGloss: "a code worked out from the sound. it is checked again when you publish.",
    },
    hear: { play: "hear it", pause: "pause", why: "why you cannot hear it yet" },
    refusals: {
      cutShort: "the cut is too short. keep at least 10 milliseconds.",
      cutLong: "the cut is too long. keep at most 30 seconds.",
      cutInverted: "the cut ends before it starts. move the end handle to the right of the start.",
      cutOutside: "the cut reaches outside the sound. pull the handles back inside it.",
      speedRange: "that speed is out of range. it has to be between a quarter and four times.",
      speedTerms: "that speed cannot be sent. pick another.",
      outputShort:
        "this flip would come out too short, under 10 milliseconds. cut a longer part or play it slower.",
      outputLong: "this flip would come out too long, over 60 seconds. cut less or play it faster.",
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
    // said on every credit line a person typed: it says the words are theirs and graft did not check them
    asTyped: "not checked",
  },
  details: {
    summary: "details",
    summaryRights: "rights and details",
    printLabel: "a line drawn from this sound's code",
    printNote:
      "drawn from the code below, so the same sound always draws the same line. a picture of the code, not of how the sound goes.",
    showCode: "show the code",
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
    /** In a browser that holds the key of a flip it published: the way to its list. */
    flips: "your flips",
    how: "how it works",
    /** The mark before the words on the replay button: a question, so it reads as help. */
    howMark: "?",
  },
  /** Marking a part of a stage on the record, to flip just that part. */
  mark: {
    toggle: "cut on the record",
    stop: "stop cutting",
    drag: "drag along a ring to mark the part you want. on a keyboard, press [ and ] on the record.",
    flipPart: "flip this part",
    clear: "clear",
    seconds: "{n} s",
    /** Changing the part's speed and hearing it on the record, before taking it to the make page. */
    edit: {
      speed: "speed of this part",
      chip: "{semitones}, {interval}",
      hear: "hear it",
      stop: "stop",
      note: "{from} s becomes {to} s at this speed.",
      failed: "the sound could not be made. try again.",
    },
  },
  /**
   * The first play tells how the sound was made, one caption for each moment of the roll, drawn from the
   * chain's own data. No caption names a maker: the credit stays in the stage's label.
   */
  narration: {
    label: "how it was made",
    teaser: "this is the finished sound. now hear how it was made.",
    teaserOne: "this is the sound.",
    began: "it began as \u201c{name}\u201d.",
    cutUp: "then a piece was cut out and sped up.",
    cutDown: "then a piece was cut out and slowed down.",
    cutSame: "then a piece was cut out and kept at the same speed.",
    cutOnly: "then a piece was cut out.",
    wholeUp: "then it was sped up.",
    wholeDown: "then it was slowed down.",
    wholeSame: "then it was kept as it was.",
    missing: "this step is no longer here. its credit stays.",
    rest: "that is how it was made. tap any ring to hear that step, or press make a flip to make the next one.",
    restOne:
      "that is all of it so far. tap the ring to hear it, or press make a flip to make the next one.",
    skip: "skip",
  },
  /** Two small hints after the first play, each shown once. */
  hints: {
    needle: "drag the needle to hear any moment.",
    mark: "like a part? mark it, change its speed, flip it.",
    perform: "press perform, then 1 2 3 to play the stages.",
  },
  /** The keys sheet: every keyboard control of a page, in words, one sheet for each kind of page. */
  keys: {
    button: "keys",
    heading: "keys",
    close: "close",
    roll: [
      {
        id: "roll",
        heading: "the roll",
        rows: [
          [
            "play, ← →",
            "the buttons at the bottom play and pause, and step to the stage before or after.",
          ],
          ["← →", "on the record: move the stylus a tenth of a second."],
          ["↑ ↓", "on the record: go to the stage outside or inside, at the same place in it."],
          ["home, end", "on the record: the start or the end of the stage."],
          ["enter, space", "on the record: play from the stylus."],
          [
            "[ and ]",
            "while marking a part: set where it starts and where it ends, at the stylus.",
          ],
          ["escape", "leave marking a part, or skip the narration."],
        ],
        note: "the dashed ring shows where the sound is. the needle follows your pointer. they are two things on purpose.",
      },
      {
        id: "perform",
        heading: "perform",
        rows: [
          [
            "1 2 3 4 5 6 7 8 9 0 - =",
            "play stages 1 to 12 by where the key is on the number row, whatever your keyboard prints there. the keypad plays 1 to 9.",
          ],
          [
            "the pads",
            "every stage is also a pad: touch it, or tab to it and press enter or space. a chain longer than twelve has pads that no key reaches.",
          ],
          [
            `${PAD_RULE.single}, ${PAD_RULE.overlap}`,
            `${PAD_RULE.single}: ${PAD_RULE.singleSays} ${PAD_RULE.overlap}: ${PAD_RULE.overlapSays}`,
          ],
          [
            "rec, play phrase, loop",
            "rec keeps the pads you press (sixteen seconds, sixty-four presses at most) as a phrase. play phrase runs them again; loop starts it over. copy link sends it: the link holds the presses and no sound.",
          ],
          [
            "escape",
            "the first press ends a recording, or silences the sound and a phrase playing. the next leaves perform.",
          ],
          [
            "cutting a part",
            "marking a part on the record ends perform, and turning perform on ends the marking: the cut tools and the pads share the bottom of the page.",
          ],
          [
            "screen readers",
            "a screen reader keeps the digit keys for itself, so use the pads: they are plain buttons.",
          ],
          [
            "a pad's corner",
            "pads 10 to 12 show their key as printed on your keyboard, where your browser can say.",
          ],
        ],
        note: null,
      },
    ],
    make: [
      {
        id: "make",
        heading: "making a flip",
        rows: [
          ["← →", "on a bracket: move it one millisecond. with shift, ten."],
          ["home, end", "on a bracket: send it to the start or the end of the sound."],
          [
            "← →",
            "on the speed: change the speed, and the sound with it, at once. that is on purpose.",
          ],
          [
            "tab",
            "goes in the order of the page: pick, hear it, the brackets, the speed, publish.",
          ],
        ],
        note: null,
      },
      {
        // the bank is perform for sketches: a build that holds perform back holds it back too
        id: "perform",
        heading: "the sketch bank",
        rows: [
          [
            "number keys: off, on",
            "the button under the pads turns the number keys on. while it is off a digit never makes a sound. 1 to 9, 0, minus and equal play pads 1 to 12, by where the key is.",
          ],
          [
            "typing in a field",
            "a digit typed in the title field, the rename field or the publish form is typed, never played, and so is every other letter and symbol.",
          ],
          [
            "escape",
            "the first press ends a recording, or silences the sound and a phrase playing. the next turns the number keys off.",
          ],
          [
            "the pads",
            "each pad is a button: tab to it and press enter or space. move earlier, move later and remove from the bank change the order from the keyboard.",
          ],
          [
            "the silent switch",
            "on a phone with the ring switch set to silent, a pad may stay quiet: turn the switch off, or turn the volume up, and press again.",
          ],
        ],
        note: null,
      },
    ],
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
  "flipped by": { word: "flipped by", gloss: "who made this stage, in their own words" },
  by: { word: "by", gloss: "who made it, in their own words" },
  "forked from": { word: "forked from", gloss: "the stage this one was cut from" },
  licence: { word: "licence", gloss: "the terms it was shared under, as the maker wrote them" },
  declaration: { word: "declaration", gloss: "what the maker said about sharing it" },
  note: { word: "note", gloss: "the maker's own words about it" },
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
