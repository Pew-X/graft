"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { padForKey } from "../lib/perform/keys.ts";
import { performAudio, type PerformAudio } from "../lib/perform/graph.ts";
import { Performer, type Rule } from "../lib/perform/performer.ts";
import type { LazyAudio } from "../lib/playback/index.ts";
import type { Live } from "./Disc.tsx";

interface Options {
  /** The roll's audio: its decoded stages and its one context. Absent until the stages have loaded. */
  audio: RefObject<LazyAudio | null>;
  /** How many stages the chain has. */
  stages: number;
  /** Whether each stage can be heard right now (here, not held, with sound). */
  playable: readonly boolean[];
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
  /** The stage last played, kept by the page (it is needed before this hook can run). */
  shown: number | null;
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
  lengths,
  prepare,
  pauseRoll,
  endNarration,
  say,
  marking,
  shown,
  setShown,
}: Options) {
  const [on, setOn] = useState(false);
  /** Whether any performed voice sounds now (a change of this re-renders; a press that keeps it does not). */
  const [sounding, setSounding] = useState(false);
  const [mode, setModeState] = useState<Rule>("cut");
  const performer = useRef<Performer | null>(null);
  const made = useRef<PerformAudio | null>(null);
  const onRef = useRef(false);
  const modeRef = useRef<Rule>("cut");
  const latest = useRef({ playable, lengths, stages });
  useEffect(() => {
    latest.current = { playable, lengths, stages };
  });

  const light = useCallback((now: readonly number[]) => {
    setSounding((was) => (was === now.length > 0 ? was : now.length > 0));
    // the pads read their lit state straight from here, so a press does not re-render the page
    for (const pad of document.querySelectorAll<HTMLElement>(".pad[data-pad]")) {
      pad.dataset["sounding"] = String(now.includes(Number(pad.dataset["pad"])));
    }
  }, []);

  /** Release whatever sounds. True when something did. */
  const silence = useCallback((): boolean => performer.current?.silence() ?? false, []);

  const press = useCallback(
    (stage: number): void => {
      const { playable: ok, stages: count } = latest.current;
      if (stage < 0 || stage >= count) return;
      const p = performer.current;
      if (!p) {
        say(copy.perform.preparing);
        return;
      }
      if (!ok[stage]) {
        say(fill(copy.perform.noSound, { n: stage + 1 }));
        return;
      }
      // the sound is started here, in the same task as the key, before anything is drawn
      const context = audio.current?.context;
      if (context && context.state !== "running") {
        void context.resume().catch(() => undefined);
        say(copy.perform.resumed);
      } else {
        say("");
      }
      if (p.press(stage)) {
        setShown(stage);
        flash(stage);
      }
    },
    [audio, say, setShown],
  );

  const leave = useCallback((): void => {
    silence();
    onRef.current = false;
    setOn(false);
    setShown(null);
    say("");
  }, [silence, say, setShown]);

  const enter = useCallback((): void => {
    if (onRef.current) return;
    onRef.current = true;
    setOn(true);
    setShown(null);
    pauseRoll();
    endNarration();
    try {
      // where the browser has it: sound keeps playing with the phone's ring switch set to silent
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
    } catch {
      /* an experimental interface that is not there, or refuses: no change */
    }
    // The press that turned perform on is the gesture that unlocks the audio.
    prepare()
      .then(() => {
        const lazy = audio.current;
        const context = lazy?.context;
        if (!lazy || !context || !onRef.current) return;
        if (!performer.current) {
          // the roll's own graph holds the decoded stages; the performer's voices share them
          void lazy.unlock().then((roll) => {
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
          });
        }
      })
      .catch(() => {
        onRef.current = false;
        setOn(false);
        say(copy.perform.failed);
      });
  }, [audio, endNarration, light, pauseRoll, prepare, say, setShown]);

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
        if (!silence()) leave();
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
  }, [on, press, leave, silence, marking]);

  // A page that is hidden, or left, goes quiet.
  useEffect(() => {
    const hidden = (): void => {
      if (document.visibilityState === "hidden") silence();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      performer.current?.silence();
      made.current?.bus.disconnect();
    };
  }, [silence]);

  /** Where the stylus is while performing: the last stage played, seconds into its sound. */
  const live = useCallback((): Live | null => {
    const last = performer.current?.last;
    if (!last) return null;
    const length = latest.current.lengths[last.stage] ?? 0;
    return { stage: last.stage, position: Math.min(length, performance.now() / 1000 - last.at) };
  }, []);

  return { on, shown, sounding, mode, setMode, enter, leave, press, silence, live };
}

/** The ring's matching pad, if it is drawn, shows that it was pressed (a short light from within). */
function flash(stage: number): void {
  const pad = document.querySelector<HTMLElement>(`.pad[data-pad="${stage}"]`);
  if (!pad) return;
  pad.classList.remove("hit");
  // reading a layout property restarts the animation when the same pad is pressed again at once
  void pad.offsetWidth;
  pad.classList.add("hit");
}
