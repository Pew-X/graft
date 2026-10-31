"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { copy, fill } from "../lib/copy.ts";
import {
  Engine,
  LazyAudio,
  attachContextLifecycle,
  attachLifecycle,
  currentStage,
  idle,
  isSounding,
  type AudioContextConstructor,
  type State,
} from "../lib/playback/index.ts";
import { captions, momentAt } from "../lib/coach/narration.ts";
import { readPhase, writePhase } from "../lib/coach/seen.ts";
import { captionBox } from "../lib/coach/where.ts";
import { levelAt, liveDye } from "../lib/thread/live.ts";
import { dyes } from "../lib/theme/tokens.ts";
import { type Rect } from "../lib/coach/marks.ts";
import { SAMPLE_RATE } from "../lib/playback/config.ts";
import type { AudioContextLike } from "../lib/playback/webaudio.ts";
import { usePerform } from "./usePerform.ts";
import {
  type Event,
  type Phase,
  follow,
  next as nextPhase,
  toolsShown,
} from "../lib/coach/first.ts";
import { readyCut, READY_SPEED } from "../lib/make/ready.ts";
import { layout, needleAt, peaksOf } from "../lib/record/disc.ts";
import {
  type Mark,
  cutHash,
  makeAddress,
  markFrames,
  markSeconds,
  parseCutHash,
} from "../lib/record/mark.ts";
import { startTelemetry } from "../lib/telemetry/browser.ts";
import type { Telemetry } from "../lib/telemetry/telemetry.ts";
import type { Loader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
import { Caption } from "./Caption.tsx";
import { CreditBlock, EndBlock } from "./CreditBlock.tsx";
import { ReportDialog } from "./ReportDialog.tsx";
import { Disc, type Live } from "./Disc.tsx";
import { EditPart } from "./EditPart.tsx";
import { Footer } from "./Footer.tsx";
import { Hint } from "./Hint.tsx";
import { KeysSheet } from "./KeysSheet.tsx";
import { PadBank } from "./PadBank.tsx";
import { useNarrow } from "./useNarrow.ts";
import type { FlipsAudio } from "./FlipsBank.tsx";
import { Thread } from "./Thread.tsx";
import { useHeld } from "./useHeld.ts";
import { MOST_PADS_BY_KEY } from "../lib/perform/keys.ts";
import { PERFORM_ON } from "../lib/perform/enabled.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

type Load = "loading" | "ready" | "failed";

/** Which side of its target each hint likes to sit: on empty space, not on the thing it explains. */
const HINT_SIDES = {
  needle: ["left", "above", "below"],
  mark: ["right", "below", "above"],
  perform: ["above", "left", "right"],
} as const;

const clock = {
  now: () => performance.now() / 1000,
  setTimeout: (fn: () => void, seconds: number) => window.setTimeout(fn, seconds * 1000),
  clearTimeout: (id: number) => window.clearTimeout(id),
};

/** Put the marked part into this page's own address (keeping the router's history state), or remove it. */
function writeCut(fragment: string | null): void {
  try {
    const here = window.location;
    if (fragment === null && !here.hash.startsWith("#cut=")) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${here.pathname}${here.search}${fragment ?? ""}`,
    );
  } catch {
    /* an address that cannot be written is only a Back that does not keep the cut */
  }
}

function audioConstructor(): AudioContextConstructor | undefined {
  const w = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return w.AudioContext ?? w.webkitAudioContext;
}

/**
 * The roll: the chain's credit blocks and the controls, over the playback engine. Nothing sounds, and
 * no audio context exists, until the first tap. Where the audio comes from is the caller's loader
 * (static files for the home page; issued addresses for a chain read from the service).
 */
export function RollPlayer({
  blocks,
  load: loadAudio,
  truncated = false,
  reportTo,
  openMake,
  makeHref,
  apiUrl,
  flipsHref,
  flipsFrom,
}: {
  blocks: readonly Block[];
  load: Loader;
  /** The chain goes back further than the page follows. */
  truncated?: boolean;
  /** Where to send best-effort counts (the service's events address); none, no counts. */
  reportTo?: string | undefined;
  /** Go to the make flow for a stage. Absent where the roll is shown without the site around it. */
  openMake?:
    | ((id: string, cut?: { start: number; end: number }, speed?: { p: number; q: number }) => void)
    | undefined;
  /** Where the bar's make a flip link goes; none, no link. */
  makeHref?: string | undefined;
  /** Where the service is, to list the flips of the stage in view: only a chain read from the service has any. */
  flipsFrom?: string | undefined;
  /** Where the service is, for reports. Without it there is nowhere to send one, so no report control is shown. */
  apiUrl?: string | undefined;
  /** The list of the flips this browser holds a key for, when it holds any: the footer links to it. */
  flipsHref?: string | undefined;
}) {
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [lengths, setLengths] = useState<number[]>(() => blocks.map((b) => b.seconds));
  const [state, setState] = useState<State>(idle);
  const [notice, setNotice] = useState("");
  const [reduced, setReduced] = useState(false);
  const [peaks, setPeaks] = useState<number[][]>([]);
  // Which stages turned out to have audio to play, once the loader has answered.
  const [heard, setHeard] = useState<boolean[] | null>(null);
  const audio = useRef<LazyAudio | null>(null);
  // each stage's audio as the engine holds it, so a marked part can be heard at another speed
  const [stageAudio, setStageAudio] = useState<ReadonlyArray<Int16Array | null>>([]);
  const engine = useRef<Promise<Engine | null> | null>(null);
  const engineNow = useRef<Engine | null>(null);
  const reducedRef = useRef(false);
  const cleanup = useRef<Array<() => void>>([]);
  const nodes = useRef<Array<HTMLElement | null>>([]);
  const telemetry = useRef<Telemetry | null>(null);
  const reported = useRef<Set<number>>(new Set());

  const playable = useMemo(
    () => blocks.map((b, i) => b.state === "available" && (heard === null || heard[i] === true)),
    [blocks, heard],
  );
  const unplayable = playable.filter((p) => !p).length;
  const unplayableText =
    unplayable === 0
      ? ""
      : unplayable === 1
        ? copy.states.summaryOne
        : fill(copy.states.summaryMany, { n: unplayable });
  const stages = blocks.length;
  const current = currentStage(state, stages);
  const playing = isSounding(state);

  // The page shows one stage large: the one playing, or the one the visitor moved to by keyboard
  // (focus follows into a stage and the roll slides to it); at rest, the finished flip.
  const [moved, setMoved] = useState<{ index: number; during: number | null } | null>(null);
  // while performing, the stage last played is the one shown large
  const [performShown, setPerformShown] = useState<number | null>(null);
  const hero =
    performShown !== null
      ? performShown
      : moved && moved.during === current
        ? moved.index
        : (current ?? stages - 1);
  const [shift, setShift] = useState(0);
  // The first placement is instant; only the moves after it slide.
  const [placed, setPlaced] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const viewportEl = useRef<HTMLDivElement>(null);
  const notesEl = useRef<HTMLDivElement>(null);
  const barEl = useRef<HTMLElement>(null);
  // how tall the header is, with the sentence under it, so what sits below it (the independence line in
  // portrait) keeps clear
  const [barHeight, setBarHeight] = useState(0);
  // marking a part of a stage on the record, to flip just that part
  const [marking, setMarking] = useState(false);
  const markingNow = useRef(false);
  useEffect(() => {
    markingNow.current = marking;
  }, [marking]);
  const [mark, setMark] = useState<Mark | null>(null);
  // a cut that came back with the browser's Back button: its speed, for the edit bar to start at
  const [restoredSpeed, setRestoredSpeed] = useState<{ p: number; q: number } | null>(null);
  // the first-visit guide: the first play narrates itself, then two small hints, each once. Where it
  // starts is read from the browser after the page is up (the server cannot know), and every step
  // forward is written back.
  const [phase, setPhase] = useState<Phase>("armed");
  const [phaseKnown, setPhaseKnown] = useState(false);
  const guide = useCallback((event: Event): void => setPhase((p) => nextPhase(p, event)), []);
  const skipNarration = useCallback(() => guide("skipped"), [guide]);
  const narrationOver = useCallback(() => guide("narrationEnded"), [guide]);
  useEffect(() => {
    // read after the page is up, in a microtask: the server cannot know what the browser has stored
    queueMicrotask(() => {
      // a link to "#how" (the about page's, or one a visitor keeps) plays the guide from the start
      setPhase(window.location.hash === "#how" ? "armed" : readPhase());
      setPhaseKnown(true);
    });
  }, []);
  useEffect(() => {
    if (phaseKnown) writePhase(phase);
  }, [phase, phaseKnown]);
  const narrating = phase === "narrating";
  // a first visit has one thing to do: the main button says what it does until the narration has begun
  const firstPlay = phaseKnown && phase === "armed";
  // where the caption sits so that it keeps clear of the record
  const [caption, setCaption] = useState(() => captionBox(1280, 720, blocks.length));
  const place = useCallback((): void => {
    const node = nodes.current[hero];
    const viewport = viewportEl.current;
    const article = node?.querySelector<HTMLElement>(":scope > article");
    if (!node || !article || !viewport) return;
    const h = window.innerHeight;
    const portrait = window.innerWidth < h * 0.9;
    // The room the stage in view has, measured: under the header (and, in portrait, the independence
    // line under it), and above the status pill and the controls (and, in portrait, above the record).
    // A stage that fits is centred a little above the middle; one that does not starts at the top of its
    // room and is a scroll region, with a fade and a word saying there is more.
    const bar = document.querySelector(".roll .bar")?.getBoundingClientRect();
    const footer = portrait
      ? document.querySelector(".roll .footer")?.getBoundingClientRect()
      : undefined;
    const controls = document.querySelector(".roll .controls")?.getBoundingClientRect();
    const roomTop =
      Math.max(bar?.bottom ?? 60, footer?.bottom ?? 0) + (portrait && h < 700 ? 6 : 14);
    // the pill's slot is always kept, whether or not it is showing, so the stage does not jump when it goes
    const notesBox = notesEl.current?.getBoundingClientRect();
    const slot = Math.max(notesBox?.height ?? 0, 50);
    const normal = (controls?.top ?? h - 70) - 16 - slot - 14;
    // a caption in portrait sits above the record, higher than the pill: the stage keeps clear of it
    const lowest =
      notesEl.current?.dataset["caption"] === "true" && portrait && notesBox
        ? Math.min(normal, notesBox.top - 14)
        : normal;
    const bottom = portrait ? Math.min(lowest, h * 0.56) : lowest;
    const natural = article.scrollHeight;
    const free = bottom - roomTop;
    const ideal = portrait
      ? roomTop + Math.min(36, Math.max(0, (free - natural) / 3))
      : h * 0.46 - natural / 2;
    const top = natural >= free ? roomTop : Math.max(roomTop, Math.min(ideal, bottom - natural));
    viewport.style.setProperty("--article-max", `${Math.max(120, Math.floor(bottom - top))}px`);
    viewport.style.setProperty("--article-top", `${article.offsetTop}px`);
    setShift(Math.round(top - (node.offsetTop + article.offsetTop)));
  }, [hero]);
  useLayoutEffect(() => {
    const bar = barEl.current;
    if (!bar) return undefined;
    const measure = (): void => {
      bar.parentElement?.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
      setBarHeight(bar.offsetHeight);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(bar);
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => {
    place();
    const settle = requestAnimationFrame(() => setPlaced(true));
    const el = sheet.current;
    if (!el) return () => cancelAnimationFrame(settle);
    // Fonts arriving, a stage's details opening, the window changing: the roll finds its place again.
    const watch = new ResizeObserver(place);
    watch.observe(el);
    // the status text changes height as it changes words; the stage's room changes with it
    if (notesEl.current) watch.observe(notesEl.current);
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) place();
    });
    return () => {
      alive = false;
      cancelAnimationFrame(settle);
      watch.disconnect();
    };
  }, [place, load, narrating, barHeight]);

  // Fetch every stage's audio. Nothing is decoded or played yet.
  // When the stage in view has more than fits, say so: a flag the styles turn into a fade and a word.
  useLayoutEffect(() => {
    const node = nodes.current[hero];
    const article = node?.querySelector<HTMLElement>(":scope > article");
    if (!node || !article) return undefined;
    const update = (): void => {
      const more = article.scrollHeight - article.scrollTop - article.clientHeight > 2;
      article.dataset["more"] = String(more);
      node.dataset["more"] = String(more);
    };
    update();
    article.addEventListener("scroll", update, { passive: true });
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    watch?.observe(article);
    return () => {
      article.removeEventListener("scroll", update);
      watch?.disconnect();
      delete article.dataset["more"];
      delete node.dataset["more"];
    };
  }, [hero, load, shift]);

  useEffect(() => {
    const abort = new AbortController();
    loadAudio(abort.signal)
      .then((pcm) => {
        audio.current = new LazyAudio(audioConstructor, pcm);
        setStageAudio(pcm);
        setHeard(pcm.map((samples) => samples !== null));
        setLengths(pcm.map((samples) => (samples === null ? 0 : samples.length / 48_000)));
        setPeaks(pcm.map((samples) => (samples === null ? [] : peaksOf(samples, 96))));
        setLoad("ready");
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoad("failed");
      });
    return () => abort.abort();
  }, [loadAudio, attempt]);

  // Back online after a failed load: try again by itself.
  useEffect(() => {
    if (load !== "failed") return;
    const again = (): void => {
      setLoad("loading");
      setAttempt((n) => n + 1);
    };
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [load]);

  // Follow the system's reduced-motion setting.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => {
      reducedRef.current = query.matches;
      setReduced(query.matches);
      void engine.current?.then((e) => e?.setReducedMotion(query.matches));
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Best-effort counts: nothing at all when the browser signals it must not be measured.
  useEffect(() => {
    const started = startTelemetry(reportTo);
    telemetry.current = started?.telemetry ?? null;
    return () => {
      started?.dispose();
      telemetry.current = null;
    };
  }, [reportTo]);
  const lastId = blocks.at(-1)?.id;
  useEffect(() => {
    if (load === "ready" && lastId) telemetry.current?.track("roll_opened", lastId);
  }, [load, lastId]);
  useEffect(() => {
    // Once per stage per visit, however many times the roll goes round.
    if (!playing || current === null || reported.current.has(current)) return;
    const block = blocks[current];
    if (!block || block.state !== "available") return;
    reported.current.add(current);
    telemetry.current?.track("stage_played", block.id);
  }, [playing, current, blocks]);

  // Keep the caption off the record at the size the window is now.
  useEffect(() => {
    const measure = (): void =>
      setCaption(captionBox(window.innerWidth, window.innerHeight, stages));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [stages]);

  // The guide follows what the visitor does: the first sound starts the narration; taking the needle or
  // a ring ends it and counts as the first hint done; marking a part is the second. It is worked out while
  // rendering, so the guide is always in step with what is on the screen.
  const sounding = state.kind;
  // a narration that has begun and then goes quiet (the sound failed, or the visitor left it) is over: it
  // must never leave the page without its skip, and the hints must still come
  const [narrationBegan, setNarrationBegan] = useState(false);
  // Leaving the page stops everything.
  useEffect(() => {
    const undo = cleanup.current;
    return () => {
      void engine.current?.then((e) => e?.routeChange());
      for (const fn of undo.splice(0)) fn();
    };
  }, []);

  /**
   * The engine, made on the first call. That call must come from a tap: the audio context is created
   * and resumed inside it.
   */
  const ensure = useCallback((): Promise<Engine | null> => {
    if (engine.current) return engine.current;
    const lazy = audio.current;
    if (!lazy) return Promise.resolve(null);
    engine.current = lazy.unlock().then((graph) => {
      const made = new Engine({
        graph,
        clock,
        lengths,
        onChange: setState,
        onError: () => setNotice(copy.hint.soundFailed),
      });
      made.setReducedMotion(reducedRef.current);
      engineNow.current = made;
      cleanup.current.push(attachLifecycle(made, { document, window }));
      if (lazy.context) cleanup.current.push(attachContextLifecycle(made, lazy.context));
      return made;
    });
    return engine.current;
  }, [lengths]);

  const act = useCallback(
    (run: (e: Engine) => void): void => {
      setNotice("");
      ensure()
        .then((e) => {
          if (e) run(e);
        })
        .catch(() => {
          engine.current = null;
          setNotice(copy.hint.soundFailed);
        });
    },
    [ensure],
  );

  /** Run something on the engine when it exists, in order with what came before (no message to the visitor). */
  const later = useCallback(
    (run: (e: Engine) => void): void => {
      ensure()
        .then((e) => {
          if (e) run(e);
        })
        .catch(() => undefined);
    },
    [ensure],
  );

  // Performing: the number keys and the pads play the stages, beside the roll and on its own sounds.
  const reasons = useMemo(
    () =>
      blocks.map((b, i) =>
        playable[i]
          ? ""
          : b.state === "available"
            ? copy.perform.why.silent
            : copy.perform.why[b.state],
      ),
    [blocks, playable],
  );
  const perform = usePerform({
    audio,
    stages,
    playable,
    reasons,
    lengths,
    prepare: ensure,
    pauseRoll: () => later((e) => e.pause()),
    // a narration that is running ends as if skipped; any other phase ignores this event
    endNarration: () => guide("skipped"),
    // the cut tools and the pad bank both sit at the bottom of the page: one at a time
    endMarking: () => {
      setMarking(false);
      setMark(null);
      setRestoredSpeed(null);
      writeCut(null);
    },
    say: setNotice,
    marking: markingNow,
    setShown: setPerformShown,
  });
  const performing = perform.on;

  // (the guide follows what the visitor does, worked out here because it reads whether perform is on)
  if (phase === "narrating" && sounding === "rolling" && !narrationBegan) setNarrationBegan(true);
  if (phase !== "narrating" && narrationBegan) setNarrationBegan(false);
  if (phaseKnown) {
    const event =
      phase === "narrating" && narrationBegan && sounding === "idle"
        ? "skipped"
        : follow(phase, {
            sounding,
            marking,
            performing,
            performAvailable: PERFORM_ON && stages > 1,
          });
    if (event !== null) setPhase(nextPhase(phase, event));
  }

  // Read by the record every frame, so the stylus follows the sound without re-rendering the page.
  const rollLive = useCallback((): Live | null => {
    const e = engineNow.current;
    const stage = e?.currentStage ?? null;
    const position = e?.stagePosition ?? null;
    return stage === null || position === null ? null : { stage, position };
  }, []);
  const live = performing ? perform.live : rollLive;
  // what sounds and which stage is lit, whether the roll or a pad made the sound
  const lit = performing ? perform.sounding : playing;
  const litStage = performing ? performShown : current;

  const markCut = mark ? markFrames(mark, (lengths[mark.stage] ?? 0) * 48_000) : null;
  const markLabel =
    mark && markCut
      ? fill(copy.mark.seconds, {
          n: markSeconds(mark, (lengths[mark.stage] ?? 0) * 48_000).toFixed(2),
        })
      : undefined;
  const narrow = useNarrow();
  // what a bank of the stage's flips borrows from the roll: its one audio context, a pause, and the stages it shows
  const flipsAudio = useMemo<FlipsAudio | undefined>(
    () =>
      flipsFrom
        ? {
            context: async () => {
              await ensure();
              const lazy = audio.current;
              await lazy?.unlock();
              if (!lazy?.context) throw new Error("no audio");
              return lazy.context as unknown as AudioContextLike;
            },
            beforeSound: () => later((e) => e.pause()),
            stageIds: new Set(blocks.map((b) => b.id)),
            ready: toolsShown(phase) && load === "ready",
          }
        : undefined,
    [flipsFrom, ensure, later, blocks, phase, load],
  );
  const status =
    notice ||
    (marking && !markCut ? copy.mark.drag : "") ||
    (performing && narrow ? copy.perform[`${perform.mode}Says`] : "") ||
    (performing
      ? fill(
          stages === 1
            ? copy.perform.hintFew
            : stages > MOST_PADS_BY_KEY
              ? copy.perform.hintMore
              : copy.perform.hint,
          { n: Math.min(stages, MOST_PADS_BY_KEY) },
        )
      : "") ||
    (load === "loading"
      ? copy.hint.loading
      : load === "failed"
        ? typeof navigator !== "undefined" && !navigator.onLine
          ? copy.offline
          : copy.hint.loadFailed
        : state.kind === "idle"
          ? // the perform hint stands above the controls, where this line is: while it is up, it speaks alone
            phase === "hintPerform"
            ? unplayableText
            : [
                phaseKnown && phase === "armed" ? copy.hint.lockedFirst : copy.hint.locked,
                unplayableText,
              ]
                .filter(Boolean)
                .join(" ")
          : "");
  const moment = narrating ? momentAt(state, stages) : null;
  const captionText = moment
    ? captions(
        moment,
        blocks,
        lengths.map((seconds) => (seconds > 0 ? Math.round(seconds * SAMPLE_RATE) : null)),
      )
    : null;
  // while the captions speak they are what is announced, so the stage is not read out a second time
  const announcement = performing
    ? performShown === null
      ? ""
      : fill(copy.perform.played, {
          n: performShown + 1,
          total: stages,
          title: blocks[performShown]?.title ?? "",
        })
    : current === null || !playing || captionText !== null
      ? ""
      : fill(copy.roll.stage, {
          n: current + 1,
          total: stages,
          title: blocks[current]?.title ?? "",
        });
  const disabled = load !== "ready";

  const leavePerform = perform.leave;
  const onPlay = useCallback(
    (index: number) => {
      leavePerform();
      act((e) => e.tapStage(index));
    },
    [act, leavePerform],
  );
  const onFlip = useCallback(
    (index: number) => {
      // The end label flips the stage before it; a stage that is not here has no sound to flip.
      const block = blocks[index] ?? blocks.at(-1);
      const id = block?.id ?? lastId;
      if (id) telemetry.current?.track("flip_started", id);
      if (!id || block?.state !== "available") {
        setNotice(copy.flip.unavailable);
        return;
      }
      if (openMake) openMake(id);
      else setNotice(copy.flip.closed);
    },
    [blocks, lastId, openMake],
  );
  const toggleMarking = useCallback(() => {
    // marking a part and performing share the bottom of the page: starting to mark leaves perform
    if (!marking) leavePerform();
    setMarking((on) => !on);
    setMark(null);
    setRestoredSpeed(null);
    writeCut(null);
  }, [leavePerform, marking]);
  // The visitor left for the make page with a part marked and came back with Back: the address still
  // says which part (and its speed), so the page opens with it marked again.
  const cutHere = openMake !== undefined && stages > 0;
  useEffect(() => {
    if (!cutHere) return;
    queueMicrotask(() => {
      const back = parseCutHash(window.location.hash, stages);
      if (!back) return;
      setMarking(true);
      setMark(back.mark);
      setRestoredSpeed(back.speed);
    });
  }, [cutHere, stages]);
  // escape leaves marking and clears the part
  useEffect(() => {
    if (!marking) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setMarking(false);
        setMark(null);
        setRestoredSpeed(null);
        writeCut(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [marking]);
  const [reporting, setReporting] = useState<{ id: string; title: string } | null>(null);
  const onReport = useCallback(
    (index: number) => {
      const block = blocks[index];
      if (block) setReporting({ id: block.id, title: block.title });
    },
    [blocks],
  );
  const register = useCallback((index: number, node: HTMLLIElement | null) => {
    nodes.current[index] = node;
  }, []);
  const onFocusBlock = useCallback(
    (index: number) => setMoved({ index, during: current }),
    [current],
  );
  const heroBlock = blocks[Math.min(hero, stages - 1)];
  // The stage on screen is live while it sounds: its colour goes to the tile, the thread and the lit
  // groove. The thread alone steps aside for a hint (which points where it ends) and for marking a part.
  const dyeNow = liveDye({
    playing: lit,
    current: litStage,
    hero,
    state: heroBlock?.state,
    dye: heroBlock?.dye,
  });
  // when the sound stops, the colour is held for as long as the thread needs to fade (a fifth of a second),
  // so the tile and the thread leave in the stage's own colour and do not snap to green first
  const dyeShown = useHeld(dyeNow, reduced ? 0 : 260);
  const threadOn = dyeNow !== null && phase !== "hintNeedle" && phase !== "hintMark" && !marking;
  const level = useCallback((): number => {
    const at = live();
    return at ? levelAt(peaks[at.stage] ?? [], at.position, lengths[at.stage] ?? 0) : 0;
  }, [live, peaks, lengths]);
  // Where the hints point, measured on the real page each time they look.
  const findNeedle = useCallback((): Rect | null => {
    const l = layout(window.innerWidth, window.innerHeight, Math.max(1, stages));
    const tip = needleAt(l, Math.min(Math.max(0, hero), Math.max(0, stages - 1)), 0);
    return { x: tip.x - 36, y: tip.y - 36, w: 72, h: 72 };
  }, [stages, hero]);
  const findPerform = useCallback((): Rect | null => {
    const button = document.querySelector(".controls .perform-toggle");
    if (!button) return null;
    const b = button.getBoundingClientRect();
    return b.width < 1 ? null : { x: b.x, y: b.y, w: b.width, h: b.height };
  }, []);
  const findMark = useCallback((): Rect | null => {
    const button = document.querySelector('.block[data-hero="true"] .mark-toggle');
    const region = document.querySelector('.block[data-hero="true"] > article');
    if (!button || !region) return null;
    const b = button.getBoundingClientRect();
    const r = region.getBoundingClientRect();
    // only while the button is wholly inside the stage's window, where it can be pressed
    if (b.width < 1 || b.y < r.y - 1 || b.y + b.height > r.y + r.height + 1) return null;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, []);
  const fadedHint = useCallback(() => guide("hintFaded"), [guide]);

  // The header's way in: the sound on the roll, already cut and sped up, so one tap on "hear it" has sound.
  const heroSeconds = lengths[Math.min(hero, stages - 1)] ?? 0;
  const ready =
    heroBlock?.state === "available" ? readyCut(Math.round(heroSeconds * SAMPLE_RATE)) : null;
  const wayIn =
    makeHref && heroBlock?.state === "available"
      ? makeAddress(heroBlock.id, ready, ready ? READY_SPEED : null)
      : makeHref;

  return (
    <div
      className="roll"
      data-playback={state.kind}
      data-stage={current ?? ""}
      data-step={state.kind === "rolling" ? state.step : ""}
      data-hero={hero}
      data-sounding={lit}
      data-perform={performing}
      data-audio={load}
      data-reduced={reduced}
      data-guide={phase}
      data-live={dyeShown ?? undefined}
    >
      {load === "ready" ? (
        <Disc
          blocks={blocks}
          lengths={lengths}
          playable={playable}
          peaks={peaks}
          live={live}
          playing={lit}
          reduced={reduced}
          accent={dyeShown === null ? undefined : dyes[dyeShown]?.fill}
          focus={hero}
          onScrubStart={(stage, offset) => {
            // the roll's own audition plays instead: perform ends, so the record, the thread and the
            // tile all follow the one sound that is playing
            perform.leave();
            act((e) => e.scrubStart(stage, offset));
          }}
          // The first touch may arrive before the audio engine exists; the move and the release wait
          // for it, in order, instead of being lost.
          onScrubMove={(stage, offset) => later((e) => e.scrubMove(stage, offset))}
          onScrubEnd={() => {
            later((e) => e.scrubEnd());
            // Some phones only unlock audio on the release of a touch, not its start.
            void audio.current?.unlock().catch(() => undefined);
          }}
          marking={marking}
          mark={mark ? { ...mark, ...(markLabel ? { label: markLabel } : {}) } : null}
          onMark={setMark}
        />
      ) : null}

      {load === "ready" && heroBlock?.state === "available" ? (
        <Thread
          id={heroBlock.id}
          hero={hero}
          stages={stages}
          on={threadOn}
          level={level}
          reduced={reduced}
        />
      ) : null}

      <header className="bar" ref={barEl}>
        <h1>{copy.site.name}</h1>
        <span className="meta" aria-hidden="true">
          {heroBlock
            ? fill(heroBlock.meta ? copy.roll.meta : copy.roll.metaShort, {
                n: hero + 1,
                total: stages,
                meta: heroBlock.meta,
              })
            : ""}
        </span>
        {wayIn ? (
          // A plain link, not Next's: this component is also bundled by the browser tests outside Next.
          <a href={wayIn} className="make-link">
            {copy.flip.makeLink}
          </a>
        ) : null}
        <ThemeToggle />
        <span className="bar-break" aria-hidden="true" />
        <p className="sentence">{copy.site.sentence}</p>
      </header>

      {phase === "hintNeedle" && load === "ready" ? (
        <Hint
          key="needle"
          text={copy.hints.needle}
          find={findNeedle}
          prefer={HINT_SIDES.needle}
          seed={23}
          onFaded={fadedHint}
        />
      ) : null}
      {phase === "hintMark" && load === "ready" && !marking ? (
        <Hint
          key="mark"
          text={copy.hints.mark}
          find={findMark}
          prefer={HINT_SIDES.mark}
          seed={41}
          onFaded={fadedHint}
        />
      ) : null}

      {phase === "hintPerform" && load === "ready" && !performing ? (
        <Hint
          key="perform"
          text={copy.hints.perform}
          find={findPerform}
          prefer={HINT_SIDES.perform}
          seed={59}
          onFaded={fadedHint}
        />
      ) : null}

      <div className="viewport" ref={viewportEl}>
        <div
          className="sheet"
          data-placed={placed}
          ref={sheet}
          style={{ transform: `translateY(${shift}px)` }}
        >
          <ol className="blocks" aria-label={copy.roll.label}>
            {blocks.map((block) => (
              <CreditBlock
                key={block.id}
                block={block}
                total={stages}
                current={current === block.index}
                hero={hero === block.index}
                playing={playing && state.kind === "auditioning" && state.stage === block.index}
                disabled={disabled || !playable[block.index]}
                onPlay={onPlay}
                onFlip={onFlip}
                onReport={apiUrl ? onReport : undefined}
                onMark={openMake ? toggleMarking : undefined}
                marking={marking}
                flipsFrom={flipsFrom}
                flipsAudio={flipsAudio}
                register={register}
                onFocusBlock={onFocusBlock}
              />
            ))}
            <EndBlock
              index={stages}
              hero={hero === stages}
              onFlip={() => onFlip(stages)}
              register={register}
              onFocusBlock={onFocusBlock}
            />
          </ol>
        </div>
      </div>

      <div
        className="notes"
        ref={notesEl}
        data-caption={captionText !== null}
        style={
          captionText !== null
            ? ({
                "--cap-left": caption.left === null ? "50%" : `${caption.left}px`,
                "--cap-tf": caption.left === null ? "translateX(-50%)" : "none",
                "--cap-bottom": `${caption.bottom}px`,
                "--cap-max": `${caption.maxWidth}px`,
              } as CSSProperties)
            : undefined
        }
      >
        {performing ? (
          <PadBank
            pads={blocks}
            playable={playable}
            reasons={reasons}
            marks={perform.marks}
            shown={performShown}
            mode={perform.mode}
            onMode={perform.setMode}
            onPress={perform.press}
            onStop={perform.phrase.stop}
            phrase={perform.phrase}
          />
        ) : null}
        {PERFORM_ON &&
        perform.phrase.invited &&
        !performing &&
        toolsShown(phase) &&
        stages > 1 &&
        load === "ready" ? (
          <div className="phrase-invite" role="group" aria-label={copy.phrase.group}>
            <p>{copy.phrase.invite}</p>
            <button type="button" onClick={() => void perform.phrase.play()}>
              {copy.phrase.inviteButton}
            </button>
            <button type="button" onClick={perform.phrase.dismiss}>
              {copy.phrase.dismiss}
            </button>
          </div>
        ) : null}
        {moment && captionText !== null ? (
          <Caption
            text={captionText}
            moment={`${moment.kind}:${moment.stage}`}
            last={moment.kind === "rest"}
            onSkip={skipNarration}
            onEnd={narrationOver}
          />
        ) : null}
        <p
          className="status"
          role="status"
          data-empty={captionText !== null || status === "" || (marking && markCut !== null)}
        >
          {marking && markCut ? "" : status}
        </p>
        {load === "failed" ? (
          <button
            type="button"
            className="retry"
            onClick={() => {
              setLoad("loading");
              setAttempt((n) => n + 1);
            }}
          >
            {copy.retry}
          </button>
        ) : null}
        {truncated ? <p className="hint">{copy.states.truncated}</p> : null}
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>

      {marking && markCut && mark ? (
        <EditPart
          samples={stageAudio[mark.stage] ?? null}
          cut={markCut}
          label={markLabel ?? ""}
          initialSpeed={restoredSpeed}
          onFlip={(speed) => {
            const id = blocks[mark.stage]?.id;
            if (!id) return;
            // the part goes into this page's address first, so Back from the make page finds it marked
            writeCut(cutHash(mark, speed));
            openMake?.(id, markCut, speed ?? undefined);
          }}
          onClear={() => {
            setMark(null);
            setRestoredSpeed(null);
            writeCut(null);
          }}
          onBeforeHear={() => act((e) => e.pause())}
        />
      ) : null}

      <div className="controls" role="group" aria-label={copy.controls.label}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (phase === "narrating") guide("tookOver");
            perform.leave();
            act((e) => e.previous());
          }}
        >
          <span aria-hidden="true">←</span>
          <span className="visually-hidden">{copy.controls.previous}</span>
        </button>
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => {
            perform.leave();
            act((e) => (playing ? e.pause() : e.play()));
          }}
        >
          {playing
            ? copy.controls.pause
            : firstPlay
              ? copy.controls.playFirst
              : reduced
                ? copy.controls.playAll
                : copy.controls.play}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (phase === "narrating") guide("tookOver");
            perform.leave();
            act((e) => e.next());
          }}
        >
          <span aria-hidden="true">→</span>
          <span className="visually-hidden">{copy.controls.next}</span>
        </button>
        {PERFORM_ON && toolsShown(phase) && stages > 1 && load === "ready" ? (
          <button
            type="button"
            className="perform-toggle"
            aria-pressed={performing}
            onClick={performing ? perform.leave : perform.enter}
          >
            {copy.perform.label}
          </button>
        ) : null}
      </div>

      {apiUrl ? (
        <ReportDialog target={reporting} apiUrl={apiUrl} onClose={() => setReporting(null)} />
      ) : null}
      <Footer
        flipsHref={flipsHref}
        onHow={() => {
          // the guide again from the start: the roll begins at its first step, and this press allows sound.
          // A cut that is open goes first: its menu would sit over the captions, and the guide's own
          // hints are for a page that is not in the middle of cutting.
          perform.leave();
          setMarking(false);
          setMark(null);
          setRestoredSpeed(null);
          writeCut(null);
          // What was sounding stops and the roll starts again in the same update as the guide restarts.
          // Left sounding, an audition (a ring tapped, a part dragged) is read as the visitor taking
          // over, which ended the narration before it began (the first audit saw a replay with no
          // captions); and a stop on its own would read as a narration that went quiet.
          const running = engineNow.current;
          if (running) {
            setNotice("");
            running.routeChange();
            guide("replay");
            running.play();
            return;
          }
          guide("replay");
          act((e) => {
            e.routeChange();
            e.play();
          });
        }}
      >
        {toolsShown(phase) ? <KeysSheet page="roll" /> : null}
      </Footer>
    </div>
  );
}
