"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { Previewer } from "../lib/make/preview.ts";
import { MixBus, type BusContext } from "../lib/perform/bus.ts";
import { padForKey } from "../lib/perform/keys.ts";
import { Performer, type Rule } from "../lib/perform/performer.ts";
import {
  MOST_PRESSES,
  MOST_UNITS,
  type Phrase,
  PhrasePlayer,
  PhraseRecorder,
  type Timers,
} from "../lib/perform/phrase.ts";
import type { AudioContextLike } from "../lib/playback/webaudio.ts";
import type { Book } from "../lib/sketch/book.ts";
import { BankGraph } from "../lib/sketch/bank-graph.ts";
import type { PadItem } from "./PadBank.tsx";
import type { PhraseControls } from "./phrase-controls.ts";

type Made = { ok: true; samples: Int16Array } | { ok: false; why: string };

const clock: Timers = {
  now: () => performance.now() / 1000,
  setTimeout: (fn, seconds) => window.setTimeout(fn, seconds * 1000),
  clearTimeout: (id) => window.clearTimeout(id as number),
};

interface Audio {
  bus: MixBus;
  graph: BankGraph;
  performer: Performer;
}

export interface BankOptions {
  /** The pads, in order: one id each. */
  ids: readonly string[];
  titleOf: (id: string) => string;
  /** The sound of one pad: made, fetched or decoded, or why it cannot be. */
  samplesOf: (id: string) => Promise<Made>;
  /** The page's one audio context, started inside the press that wants sound. */
  getContext: () => Promise<AudioContextLike>;
  /** Something on the page is about to sound: whatever else sounds goes quiet. */
  beforeSound: () => void;
  say: (text: string) => void;
  words: {
    preparing: string;
    recording: string;
    phraseKept: (n: number, linked: boolean) => string;
    padRemoved: string;
  };
  /** A phrase that came with a link: offered, never played by itself. */
  arrived?: { presses: Phrase; ids: string[] } | null;
  /**
   * A phrase was kept (or removed): where it goes, if anywhere. Returns whether it could be put in the address,
   * which is what lets "link" copy it.
   */
  onPhrase?: (phrase: { presses: Phrase; ids: string[] } | null) => boolean;
  /** Copy the address that carries the phrase. */
  copyLink?: () => void;
}

/**
 * Playing pads with the pads themselves and, when the maker turns them on, the number keys: the same rules as
 * perform on the roll (cut or overlap, stop, rec, play, loop), over the page's one audio context.
 * Nothing is published. A phrase is which pad and when; a pad taken off the bank leaves its phrase saying so
 * rather than quietly renumbering it. A press on a pad that is not ready yet starts the audio inside the press
 * itself and plays when it is ready, so no press is ever silent without a reason.
 */
export function useBank({
  ids,
  titleOf,
  samplesOf,
  getContext,
  beforeSound,
  say,
  words,
  arrived = null,
  onPhrase,
  copyLink: copyLinkOption,
}: BankOptions) {
  const {
    preparing: wordsPreparing,
    recording: wordsRecording,
    padRemoved: wordsPadRemoved,
  } = words;
  const [made, setMade] = useState<Record<string, Made | "loading">>({});
  const [again, setAgain] = useState(0);
  const madeRef = useRef(made);
  useEffect(() => {
    madeRef.current = made;
  });
  const [mode, setModeState] = useState<Rule>("single");
  const modeRef = useRef<Rule>("single");
  const [keysOn, setKeysOn] = useState(false);
  const audio = useRef<Audio | null>(null);
  const starting = useRef<Promise<boolean> | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  });

  // Each pad's sound is made when the sketch is put on the bank (and kept while it stays there).
  useEffect(() => {
    for (const id of ids) {
      if (madeRef.current[id] !== undefined) continue;
      madeRef.current = { ...madeRef.current, [id]: "loading" };
      setMade(madeRef.current);
      void samplesOf(id).then((result) => {
        madeRef.current = { ...madeRef.current, [id]: result };
        setMade(madeRef.current);
      });
    }
  }, [ids, samplesOf, again]);

  const pads: PadItem[] = useMemo(
    () => ids.map((id, i) => ({ id, dye: (i % 4) as 0 | 1 | 2 | 3, title: titleOf(id) })),
    [ids, titleOf],
  );
  const playable = ids.map((id) => {
    const m = made[id];
    return typeof m === "object" && m.ok;
  });
  const reasons = ids.map((id) => {
    const m = made[id];
    if (m === undefined || m === "loading") return wordsPreparing;
    return m.ok ? "" : m.why;
  });

  const light = useCallback((now: readonly number[]) => {
    for (const pad of document.querySelectorAll<HTMLElement>(".sketch-bank .pad[data-pad]")) {
      pad.dataset["sounding"] = String(now.includes(Number(pad.dataset["pad"])));
    }
  }, []);

  // The performer's pads follow the bank: its order, and the sounds that are ready.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    a.performer.silence();
    a.graph.setPads(
      ids.map((id) => {
        const m = made[id];
        return { id, samples: typeof m === "object" && m.ok ? m.samples : null };
      }),
    );
    const next = new Performer({
      graph: a.graph,
      stages: ids.length,
      onChange: (now) => light(now),
    });
    next.mode = modeRef.current;
    a.performer = next;
  }, [ids, made, light]);

  /** Make the voices on the page's one context, from inside the press that wants sound. */
  const ensure = useCallback((): Promise<boolean> => {
    if (audio.current) return Promise.resolve(true);
    if (starting.current) return starting.current;
    const started = (async (): Promise<boolean> => {
      try {
        const context = await getContext();
        const bus = new MixBus(context as unknown as BusContext);
        const graph = new BankGraph(context, bus);
        graph.setPads(
          idsRef.current.map((id) => {
            const m = madeRef.current[id];
            return { id, samples: typeof m === "object" && m.ok ? m.samples : null };
          }),
        );
        const performer = new Performer({
          graph,
          stages: idsRef.current.length,
          onChange: (now) => light(now),
        });
        performer.mode = modeRef.current;
        audio.current = { bus, graph, performer };
        return true;
      } catch {
        say(copy.perform.failed);
        return false;
      } finally {
        starting.current = null;
      }
    })();
    starting.current = started;
    return started;
  }, [getContext, light, say]);

  const silence = useCallback((): boolean => audio.current?.performer.silence() ?? false, []);

  // --- A phrase: which pad and when, for this visit only
  const [recording, setRecording] = useState(false);
  const [phrase, setPhrase] = useState<{ presses: Phrase; ids: string[] } | null>(arrived);
  const [invited, setInvited] = useState(arrived !== null);
  const [linkable, setLinkable] = useState(arrived !== null);
  const [phraseSounding, setPhraseSounding] = useState(false);
  const phraseRef = useRef(phrase);
  useEffect(() => {
    phraseRef.current = phrase;
  });

  const [loop, setLoopState] = useState(false);
  const loopRef = useRef(false);
  const [recorder] = useState(() => new PhraseRecorder(clock.now));
  const limit = useRef<number | null>(null);
  const player = useRef<PhrasePlayer | null>(null);

  const playPad = useCallback(
    (index: number): boolean => {
      const a = audio.current;
      if (!a) return false;
      const ok = madeRef.current[idsRef.current[index] ?? ""];
      if (typeof ok !== "object" || !ok.ok) return false;
      void getContext().catch(() => undefined);
      beforeSound();
      if (!a.performer.press(index)) return false;
      setShown(index);
      return true;
    },
    [beforeSound, getContext],
  );
  const playRef = useRef(playPad);
  useEffect(() => {
    playRef.current = playPad;
  });

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
    const entry = { presses: kept, ids: [...idsRef.current] };
    setPhrase(entry);
    setInvited(false);
    // a bank with an address puts the phrase in it; one without says it is kept for this visit only
    const wrote = onPhrase ? onPhrase(entry) : false;
    setLinkable(wrote);
    say(words.phraseKept(kept.length, wrote));
  }, [onPhrase, recorder, say, words]);

  const press = useCallback(
    (index: number): void => {
      const id = idsRef.current[index];
      if (id === undefined) return;
      const m = madeRef.current[id];
      if (typeof m !== "object" || !m.ok) {
        const why = m === undefined || m === "loading" ? wordsPreparing : m.why;
        say(fill(copy.perform.unplayable, { n: index + 1, why }));
        return;
      }
      const sounded = (): void => {
        if (!playPad(index) || !recorder.active) return;
        if (!recorder.note(index)) {
          finishRecording();
          return;
        }
        if (recorder.count === 1)
          limit.current = window.setTimeout(finishRecording, MOST_UNITS * 10);
        if (recorder.count >= MOST_PRESSES) finishRecording();
      };
      if (audio.current) {
        say("");
        sounded();
        return;
      }
      // the first press: the audio starts inside this press, and the pad plays as soon as it can
      say(copy.perform.preparing);
      void ensure().then((ok) => {
        if (!ok) return;
        say("");
        sounded();
      });
    },
    [ensure, finishRecording, playPad, recorder, say, wordsPreparing],
  );

  useEffect(() => {
    const made = new PhrasePlayer({
      press: (stored) => {
        const entry = phraseRef.current;
        const id = entry?.ids[stored];
        const at = id === undefined ? -1 : idsRef.current.indexOf(id);
        if (at < 0) {
          say(wordsPadRemoved);
          return;
        }
        playRef.current(at);
      },
      timers: clock,
      onEnd: () => setPhraseSounding(false),
    });
    player.current = made;
    return () => {
      made.stop();
      player.current = null;
      if (limit.current !== null) window.clearTimeout(limit.current);
      limit.current = null;
      recorder.stop();
    };
  }, [recorder, say, wordsPadRemoved]);

  const stopPhrase = useCallback((): boolean => {
    const was = player.current?.playing ?? false;
    player.current?.stop();
    setPhraseSounding(false);
    return was;
  }, []);

  const record = useCallback((): void => {
    if (recorder.active) {
      finishRecording();
      return;
    }
    stopPhrase();
    recorder.start();
    setRecording(true);
    say(wordsRecording);
  }, [finishRecording, recorder, say, stopPhrase, wordsRecording]);

  const playPhrase = useCallback(async (): Promise<void> => {
    if (!phrase) return;
    finishRecording();
    setInvited(false);
    if (!(await ensure())) return;
    silence();
    setPhraseSounding(true);
    player.current?.play(phrase.presses, loopRef.current);
  }, [ensure, finishRecording, phrase, silence]);

  const stopAll = useCallback((): void => {
    stopPhrase();
    finishRecording();
    silence();
  }, [finishRecording, silence, stopPhrase]);

  const setLoop = useCallback((on: boolean): void => {
    loopRef.current = on;
    player.current?.setLoop(on);
    setLoopState(on);
  }, []);

  const clear = useCallback((): void => {
    stopPhrase();
    if (recorder.active) {
      recorder.stop();
      setRecording(false);
    }
    setPhrase(null);
    setInvited(false);
    onPhrase?.(null);
    say(copy.phrase.removed);
  }, [onPhrase, recorder, say, stopPhrase]);

  const setMode = useCallback((rule: Rule): void => {
    modeRef.current = rule;
    setModeState(rule);
    if (audio.current) audio.current.performer.mode = rule;
  }, []);

  // The number keys, only while the maker has turned them on (a character key that plays a sound needs a way off).
  useEffect(() => {
    if (!keysOn || ids.length === 0) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (document.querySelector("dialog[open]")) return;
        if (recorder.active) {
          finishRecording();
          return;
        }
        const wasPlaying = stopPhrase();
        if (!silence() && !wasPlaying) setKeysOn(false);
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const index = padForKey(
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
        idsRef.current.length,
      );
      if (index === null) return;
      event.preventDefault();
      press(index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysOn, ids.length, press, recorder, finishRecording, stopPhrase, silence]);

  // A page that is hidden, or left, goes quiet.
  useEffect(() => {
    const hidden = (): void => {
      if (document.visibilityState === "hidden") {
        finishRecording();
        stopPhrase();
        silence();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      audio.current?.performer.silence();
      audio.current?.bus.disconnect();
      audio.current = null;
    };
  }, [finishRecording, silence, stopPhrase]);

  const phraseControls: PhraseControls = useMemo(
    () => ({
      has: phrase !== null,
      length: phrase?.presses.length ?? 0,
      invited,
      recording,
      playing: phraseSounding,
      loop,
      canLink: onPhrase !== undefined,
      record,
      play: playPhrase,
      stop: stopAll,
      setLoop,
      clear,
      copyLink: () => {
        if (!linkable) say(copy.phrase.noLink);
        else copyLinkOption?.();
      },
      dismiss: () => setInvited(false),
    }),
    [
      phrase,
      invited,
      linkable,
      onPhrase,
      copyLinkOption,
      say,
      recording,
      phraseSounding,
      loop,
      record,
      playPhrase,
      stopAll,
      setLoop,
      clear,
    ],
  );

  /** Ask again for one pad's sound, after it failed. */
  const retry = useCallback((id: string): void => {
    const rest = { ...madeRef.current };
    delete rest[id];
    madeRef.current = rest;
    setMade(rest);
    setAgain((n) => n + 1);
  }, []);

  return {
    retry,
    pads,
    playable,
    reasons,
    shown,
    mode,
    setMode,
    keysOn,
    setKeysOn,
    press,
    stop: stopAll,
    phrase: phraseControls,
  };
}

/** The sketch bank on the make page: the sketches on the pads, made here, over the page's one context. */
export function useSketchBank({
  previewer,
  book,
  samplesOf,
  beforeSound,
  say,
}: {
  previewer: Previewer;
  book: Book;
  samplesOf: (id: string) => Promise<Made>;
  beforeSound: () => void;
  say: (text: string) => void;
}) {
  const titleOf = useCallback(
    (id: string): string => book.sketches.find((s) => s.id === id)?.title ?? "",
    [book.sketches],
  );
  const getContext = useCallback(
    async (): Promise<AudioContextLike> =>
      (await previewer.unlock()) as unknown as AudioContextLike,
    [previewer],
  );
  const words = useMemo(
    () => ({
      preparing: copy.sketch.bank.preparing,
      recording: copy.sketch.bank.recording,
      phraseKept: (n: number) => fill(copy.sketch.bank.phraseKept, { n }),
      padRemoved: copy.sketch.bank.padRemoved,
    }),
    [],
  );
  return useBank({
    ids: book.bank,
    titleOf,
    samplesOf,
    getContext,
    beforeSound,
    say,
    words,
  });
}
