"use client";

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { padForKey } from "../lib/perform/keys.ts";
import { performAudio, type PerformAudio } from "../lib/perform/graph.ts";
import { printedMarks, type KeyboardLike } from "../lib/perform/layout.ts";
import { PERFORM_ON } from "../lib/perform/enabled.ts";
import { Performer, type Rule } from "../lib/perform/performer.ts";
import {
  encodePhrase,
  parsePhraseHash,
  PhrasePlayer,
  PhraseRecorder,
  MOST_PRESSES,
  MOST_UNITS,
  type Phrase,
  type Timers,
} from "../lib/perform/phrase.ts";
import type { LazyAudio } from "../lib/playback/index.ts";
import type { Live } from "./Disc.tsx";

interface Options {
  /** The roll's audio: its decoded stages and its one context. Absent until the stages have loaded. */
  audio: RefObject<LazyAudio | null>;
  /** How many stages the chain has. */
  stages: number;
  /** Whether each stage can be heard right now (here, not held, with sound). */
  playable: readonly boolean[];
  /** For a stage that cannot be heard, why, in words; empty for one that can. */
  reasons: readonly string[];
  /** Length of each stage's sound in seconds. */
  lengths: readonly number[];
  /** Make the roll's playback engine, and in doing so unlock the audio: called inside the press. */
  prepare: () => Promise<unknown>;
  /** Pause what the roll is sounding, keeping its place. */
  pauseRoll: () => void;
  /** The narration, if it is running, ends as if skipped. */
  endNarration: () => void;
  /** Where words for the visitor go (the polite status line). */
  say: (text: string) => void;
  /** Whether a part is being marked on the record: Escape belongs to it first. */
  marking: RefObject<boolean>;
  /** Record the stage last played, which the page keeps (it is needed before this hook can run). */
  setShown: (stage: number | null) => void;
}

/**
 * Performing the roll from the keyboard and the pads. The roll stays as it is and does not change; this is
 * its own voices beside it, on its context and its decoded stages. Perform is a mode with an off switch
 * (digits are character-key shortcuts, which need one), so the keys act only while it is on.
 */
export function usePerform({
  audio,
  stages,
  playable,
  reasons,
  lengths,
  prepare,
  pauseRoll,
  endNarration,
  say,
  marking,
  setShown,
}: Options) {
  const [on, setOn] = useState(false);
  /** Whether any performed voice sounds now (a change of this re-renders; a press that keeps it does not). */
  const [sounding, setSounding] = useState(false);
  const [mode, setModeState] = useState<Rule>("cut");
  const performer = useRef<Performer | null>(null);
  const made = useRef<PerformAudio | null>(null);
  const onRef = useRef(false);
  /** The performer is being made (two quick presses of perform must not make two). */
  const making = useRef(false);
  /** Settles when the voices are ready after perform was turned on. */
  const ready = useRef<Promise<boolean> | null>(null);
  /** The audio session type before perform set it to playback, to put back on leaving. */
  const savedSession = useRef<string | null>(null);
  const modeRef = useRef<Rule>("cut");
  const [marks, setMarks] = useState<Record<number, string> | null>(null);
  const latest = useRef({ playable, reasons, lengths, stages });
  useEffect(() => {
    latest.current = { playable, reasons, lengths, stages };
  });

  const light = useCallback((now: readonly number[]) => {
    setSounding(now.length > 0);
    // the pads read their lit state straight from here, so a press does not re-render the page
    for (const pad of document.querySelectorAll<HTMLElement>(".pad[data-pad]")) {
      pad.dataset["sounding"] = String(now.includes(Number(pad.dataset["pad"])));
    }
  }, []);

  /** Release whatever sounds. True when something did. */
  const silence = useCallback((): boolean => performer.current?.silence() ?? false, []);

  /** Sound a stage, by a key, a pad or a phrase playing back. True when it sounded. */
  const sound = useCallback(
    (stage: number): boolean => {
      const { playable: ok, reasons: why, stages: count } = latest.current;
      if (stage < 0 || stage >= count) return false;
      const p = performer.current;
      if (!p) {
        say(copy.perform.preparing);
        return false;
      }
      if (!ok[stage]) {
        say(fill(copy.perform.unplayable, { n: stage + 1, why: why[stage] ?? "" }));
        return false;
      }
      // the sound is started here, in the same task as the key, before anything is drawn
      const context = audio.current?.context;
      if (context && context.state !== "running") {
        void context.resume().catch(() => undefined);
        say(copy.perform.resumed);
      } else {
        say("");
      }
      if (!p.press(stage)) return false;
      setShown(stage);
      flash(stage);
      return true;
    },
    [audio, say, setShown],
  );

  // --- A phrase: the presses made while performing, kept in the page's own address (lib/perform/phrase.ts)
  const [phrase, setPhrase] = useState<Phrase | null>(null);
  /** The phrase came with the link and has not been played or dismissed: the quiet invitation shows. */
  const [invited, setInvited] = useState(false);
  const [recording, setRecording] = useState(false);
  const [phraseSounding, setPhraseSounding] = useState(false);
  const [loop, setLoopState] = useState(false);
  const loopRef = useRef(false);
  const limit = useRef<number | null>(null);
  const [recorder] = useState(() => new PhraseRecorder(clock.now));
  /** The phrase can go in a link (a pad past the twelfth has no place in one). */
  const [linkable, setLinkable] = useState(true);
  const soundRef = useRef(sound);
  const playerRef = useRef<PhrasePlayer | null>(null);
  useEffect(() => {
    soundRef.current = sound;
  });
  // the player calls back into the latest `sound`, so it is made once, after the first render
  useEffect(() => {
    const made = new PhrasePlayer({
      press: (stage) => void soundRef.current(stage),
      timers: clock,
      onEnd: () => setPhraseSounding(false),
    });
    playerRef.current = made;
    return () => {
      made.stop();
      playerRef.current = null;
      // a recording left behind by leaving the page must not write its address later
      if (limit.current !== null) window.clearTimeout(limit.current);
      limit.current = null;
      recorder.stop();
    };
  }, [recorder]);

  // A phrase in the address (a link that was sent) is offered, never played by itself.
  useEffect(() => {
    if (!PERFORM_ON || stages < 2) return;
    queueMicrotask(() => {
      const found = parsePhraseHash(window.location.hash, stages);
      if (!found) return;
      setPhrase(found);
      setInvited(true);
    });
  }, [stages]);

  const finishRecording = useCallback((): void => {
    if (!recorder.active) return;
    if (limit.current !== null) window.clearTimeout(limit.current);
    limit.current = null;
    const kept = recorder.stop();
    setRecording(false);
    if (kept.length === 0) {
      say(copy.phrase.empty);
      return;
    }
    setPhrase(kept);
    setInvited(false);
    const wrote = writePhrase(encodePhrase(kept));
    setLinkable(wrote);
    say(fill(wrote ? copy.phrase.kept : copy.phrase.keptNoLink, { n: kept.length }));
  }, [recorder, say]);

  /** A key or a pad: sounds the stage, and keeps the press when a phrase is being recorded. */
  const press = useCallback(
    (stage: number): void => {
      if (!sound(stage) || !recorder.active) return;
      if (!recorder.note(stage)) {
        finishRecording();
        return;
      }
      // sixteen seconds from the first press, or sixty-four presses, whichever comes first
      if (recorder.count === 1) {
        limit.current = window.setTimeout(finishRecording, MOST_UNITS * 10);
      }
      if (recorder.count >= MOST_PRESSES) finishRecording();
    },
    [finishRecording, recorder, sound],
  );

  const record = useCallback((): void => {
    if (recorder.active) {
      finishRecording();
      return;
    }
    playerRef.current?.stop();
    setPhraseSounding(false);
    recorder.start();
    setRecording(true);
    setInvited(false);
    say(copy.phrase.recording);
  }, [finishRecording, recorder, say]);

  /** Stop a phrase that is playing (its sound is released by the caller). True when one was. */
  const stopPhrase = useCallback((): boolean => {
    const was = playerRef.current?.playing ?? false;
    playerRef.current?.stop();
    setPhraseSounding(false);
    return was;
  }, []);

  const setLoop = useCallback((on: boolean): void => {
    loopRef.current = on;
    playerRef.current?.setLoop(on);
    setLoopState(on);
  }, []);

  const clearPhrase = useCallback((): void => {
    stopPhrase();
    if (recorder.active) {
      recorder.stop();
      setRecording(false);
    }
    setPhrase(null);
    setInvited(false);
    writePhrase(null);
    say(copy.phrase.removed);
  }, [recorder, say, stopPhrase]);

  const copyLink = useCallback((): void => {
    const done = (): void => say(copy.phrase.copied);
    const failed = (): void => say(copy.phrase.copyFailed);
    if (!linkable || !parsePhraseHash(window.location.hash, latest.current.stages)) {
      say(copy.phrase.noLink);
      return;
    }
    try {
      navigator.clipboard.writeText(window.location.href).then(done, failed);
    } catch {
      failed();
    }
  }, [linkable, say]);

  const leave = useCallback((): void => {
    finishRecording();
    stopPhrase();
    silence();
    performer.current?.reset();
    // the page's audio session goes back to what it was before perform changed it
    if (savedSession.current !== null) {
      try {
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
        if (session) session.type = savedSession.current;
      } catch {
        /* an experimental interface that refuses: no change */
      }
      savedSession.current = null;
    }
    onRef.current = false;
    setOn(false);
    setShown(null);
    say("");
  }, [finishRecording, silence, say, setShown, stopPhrase]);

  /** Turn perform on; resolves true once the voices are ready (false if the sound could not start). */
  const begin = useCallback((): Promise<boolean> => {
    if (onRef.current) return ready.current ?? Promise.resolve(performer.current !== null);
    onRef.current = true;
    setOn(true);
    setShown(null);
    pauseRoll();
    endNarration();
    // what is printed on the keys, where the browser can say (labels only: the keys are by position)
    void printedMarks((navigator as unknown as { keyboard?: KeyboardLike }).keyboard).then(
      setMarks,
    );
    try {
      // where the browser has it: sound keeps playing with the phone's ring switch set to silent
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) {
        savedSession.current = session.type;
        session.type = "playback";
      }
    } catch {
      /* an experimental interface that is not there, or refuses: no change */
    }
    const failed = (): boolean => {
      // said, and perform goes off: a mode that cannot play is not left on
      making.current = false;
      onRef.current = false;
      setOn(false);
      say(copy.perform.failed);
      return false;
    };
    // The press that turned perform on is the gesture that unlocks the audio.
    const chain = prepare()
      .then(async (): Promise<boolean> => {
        const lazy = audio.current;
        const context = lazy?.context;
        if (!lazy || !context || !onRef.current) return false;
        if (performer.current) return true;
        if (making.current) return false;
        making.current = true;
        try {
          // the roll's own graph holds the decoded stages; the performer's voices share them
          const roll = await lazy.unlock();
          made.current = performAudio(roll, context);
          performer.current = new Performer({
            graph: made.current.graph,
            stages: latest.current.stages,
            onChange: light,
          });
          performer.current.mode = modeRef.current;
          const timing = context as unknown as { baseLatency?: number; outputLatency?: number };
          document
            .querySelector(".roll")
            ?.setAttribute(
              "data-latency",
              `${Math.round((timing.baseLatency ?? 0) * 1000)}+${Math.round((timing.outputLatency ?? 0) * 1000)}`,
            );
          return onRef.current;
        } catch {
          return failed();
        }
      })
      .catch(failed);
    ready.current = chain;
    return chain;
  }, [audio, endNarration, light, pauseRoll, prepare, say, setShown]);

  const enter = useCallback((): void => {
    void begin();
  }, [begin]);

  /** Play the phrase: turns perform on first if it is off (the press is the gesture that lets sound start). */
  const playPhrase = useCallback(async (): Promise<void> => {
    if (!phrase) return;
    finishRecording();
    setInvited(false);
    if (!(await begin())) return;
    silence();
    setPhraseSounding(true);
    playerRef.current?.play(phrase, loopRef.current);
  }, [begin, finishRecording, phrase, silence]);

  /** The stop button: silence the sound, and end a phrase that is playing. */
  const stopAll = useCallback((): void => {
    stopPhrase();
    finishRecording();
    silence();
  }, [finishRecording, silence, stopPhrase]);

  const setMode = useCallback((rule: Rule): void => {
    modeRef.current = rule;
    setModeState(rule);
    if (performer.current) performer.current.mode = rule;
  }, []);

  // The keys, while perform is on.
  useEffect(() => {
    if (!on) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        // a dialog, then a part being marked, own Escape before perform does
        if (document.querySelector("dialog[open]") || marking.current) return;
        // recording ends first (and keeps the phrase), then a playing phrase, then the sound, then perform
        if (recorder.active) {
          finishRecording();
          return;
        }
        const wasPlaying = stopPhrase();
        if (!silence() && !wasPlaying) leave();
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const stage = padForKey(
        {
          code: event.code,
          repeat: event.repeat,
          isComposing: event.isComposing,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          target: target && {
            tagName: target.tagName,
            isContentEditable: target.isContentEditable,
          },
        },
        latest.current.stages,
      );
      if (stage === null) return;
      event.preventDefault();
      press(stage);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on, press, leave, silence, marking, recorder, finishRecording, stopPhrase]);

  // A page that is hidden, or left, goes quiet.
  useEffect(() => {
    const hidden = (): void => {
      if (document.visibilityState === "hidden") {
        // a phrase that plays on behind a hidden page would sound with nobody there
        finishRecording();
        stopPhrase();
        silence();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      performer.current?.silence();
      made.current?.bus.disconnect();
    };
  }, [finishRecording, silence, stopPhrase]);

  /** Where the stylus is while performing: the last stage played, seconds into its sound. */
  const live = useCallback((): Live | null => {
    const last = performer.current?.last;
    if (!last) return null;
    const length = latest.current.lengths[last.stage] ?? 0;
    return { stage: last.stage, position: Math.min(length, performance.now() / 1000 - last.at) };
  }, []);

  const dismiss = useCallback((): void => setInvited(false), []);
  const controls = useMemo(
    () => ({
      has: phrase !== null,
      length: phrase?.length ?? 0,
      invited,
      recording,
      playing: phraseSounding,
      loop,
      record,
      play: playPhrase,
      stop: stopAll,
      setLoop,
      clear: clearPhrase,
      copyLink,
      dismiss,
    }),
    [
      phrase,
      invited,
      recording,
      phraseSounding,
      loop,
      record,
      playPhrase,
      stopAll,
      setLoop,
      clearPhrase,
      copyLink,
      dismiss,
    ],
  );

  return {
    on,
    sounding,
    mode,
    marks,
    setMode,
    enter,
    leave,
    press,
    silence,
    live,
    phrase: controls,
  };
}

const clock: Timers = {
  now: () => performance.now() / 1000,
  setTimeout: (fn, seconds) => window.setTimeout(fn, seconds * 1000),
  clearTimeout: (id) => window.clearTimeout(id as number),
};

/** Put the phrase into this page's own address (keeping the router's history state), or remove it. */
function writePhrase(fragment: string | null): boolean {
  try {
    const here = window.location;
    // another fragment (the guide's #how, a marked part's #cut=) is not this function's to replace
    if (here.hash !== "" && !here.hash.startsWith("#phrase=")) return false;
    if (fragment === null && here.hash === "") return true;
    window.history.replaceState(
      window.history.state,
      "",
      `${here.pathname}${here.search}${fragment ?? ""}`,
    );
    return fragment !== null;
  } catch {
    /* an address that cannot be written only means the link does not carry the phrase */
    return false;
  }
}

/** What the pad bank and the invitation need of the phrase. */
export type PhraseControls = ReturnType<typeof usePerform>["phrase"];

/** The ring's matching pad, if it is drawn, shows that it was pressed (a short light from within). */
function flash(stage: number): void {
  const pad = document.querySelector<HTMLElement>(`.pad[data-pad="${stage}"]`);
  if (!pad) return;
  pad.classList.remove("hit");
  // reading a layout property restarts the animation when the same pad is pressed again at once
  void pad.offsetWidth;
  pad.classList.add("hit");
}
