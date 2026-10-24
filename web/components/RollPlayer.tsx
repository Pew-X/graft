"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { coachSeen } from "../lib/coach/seen.ts";
import { peaksOf } from "../lib/record/disc.ts";
import { type Mark, markFrames, markSeconds } from "../lib/record/mark.ts";
import { startTelemetry } from "../lib/telemetry/browser.ts";
import type { Telemetry } from "../lib/telemetry/telemetry.ts";
import type { Loader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
import { Coach, type CoachStep } from "./Coach.tsx";
import { CreditBlock, EndBlock } from "./CreditBlock.tsx";
import { ReportDialog } from "./ReportDialog.tsx";
import { Disc, type Live } from "./Disc.tsx";
import { Footer } from "./Footer.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

type Load = "loading" | "ready" | "failed";

const clock = {
  now: () => performance.now() / 1000,
  setTimeout: (fn: () => void, seconds: number) => window.setTimeout(fn, seconds * 1000),
  clearTimeout: (id: number) => window.clearTimeout(id),
};

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
}: {
  blocks: readonly Block[];
  load: Loader;
  /** The chain goes back further than the page follows. */
  truncated?: boolean;
  /** Where to send best-effort counts (the service's events address); none, no counts. */
  reportTo?: string | undefined;
  /** Go to the make flow for a stage. Absent where the roll is shown without the site around it. */
  openMake?: ((id: string, cut?: { start: number; end: number }) => void) | undefined;
  /** Where the bar's make a flip link goes; none, no link. */
  makeHref?: string | undefined;
  /** Where the service is, for reports. Without it there is nowhere to send one, so no report control is shown. */
  apiUrl?: string | undefined;
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
  const hero = moved && moved.during === current ? moved.index : (current ?? stages - 1);
  const [shift, setShift] = useState(0);
  // The first placement is instant; only the moves after it slide.
  const [placed, setPlaced] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const viewportEl = useRef<HTMLDivElement>(null);
  const notesEl = useRef<HTMLDivElement>(null);
  // the first-visit coach: shown once to a browser that has not seen it, and again on request
  // marking a part of a stage on the record, to flip just that part
  const [marking, setMarking] = useState(false);
  const [mark, setMark] = useState<Mark | null>(null);
  const [coachOpen, setCoachOpen] = useState(false);
  const coachChecked = useRef(false);
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
    const roomTop = Math.max(bar?.bottom ?? 60, footer?.bottom ?? 0) + 14;
    // the pill's slot is always kept, whether or not it is showing, so the stage does not jump when it goes
    const slot = Math.max(notesEl.current?.getBoundingClientRect().height ?? 0, 50);
    const lowest = (controls?.top ?? h - 70) - 16 - slot - 14;
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
  }, [place, load]);

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
    if (load !== "ready" || coachChecked.current) return undefined;
    if (coachSeen()) {
      coachChecked.current = true;
      return undefined;
    }
    // after the roll has slid to its stage, so the notes point at things that have stopped moving
    const id = window.setTimeout(() => {
      coachChecked.current = true;
      setCoachOpen(true);
    }, 900);
    return () => window.clearTimeout(id);
  }, [load]);

  useEffect(() => {
    const abort = new AbortController();
    loadAudio(abort.signal)
      .then((pcm) => {
        audio.current = new LazyAudio(audioConstructor, pcm);
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

  // Read by the record every frame, so the stylus follows the sound without re-rendering the page.
  const live = useCallback((): Live | null => {
    const e = engineNow.current;
    const stage = e?.currentStage ?? null;
    const position = e?.stagePosition ?? null;
    return stage === null || position === null ? null : { stage, position };
  }, []);

  const markCut = mark ? markFrames(mark, (lengths[mark.stage] ?? 0) * 48_000) : null;
  const markLabel =
    mark && markCut
      ? fill(copy.mark.seconds, {
          n: markSeconds(mark, (lengths[mark.stage] ?? 0) * 48_000).toFixed(2),
        })
      : undefined;
  const status =
    notice ||
    (marking && !markCut ? copy.mark.drag : "") ||
    (load === "loading"
      ? copy.hint.loading
      : load === "failed"
        ? typeof navigator !== "undefined" && !navigator.onLine
          ? copy.offline
          : copy.hint.loadFailed
        : state.kind === "idle"
          ? [copy.hint.locked, unplayableText].filter(Boolean).join(" ")
          : "");
  const announcement =
    current === null || !playing
      ? ""
      : fill(copy.roll.stage, {
          n: current + 1,
          total: stages,
          title: blocks[current]?.title ?? "",
        });
  const disabled = load !== "ready";

  const onPlay = useCallback((index: number) => act((e) => e.tapStage(index)), [act]);
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
    setMarking((on) => !on);
    setMark(null);
  }, []);
  // escape leaves marking and clears the part
  useEffect(() => {
    if (!marking) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setMarking(false);
        setMark(null);
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
  const coachSteps = useMemo<readonly CoachStep[]>(
    () => (makeHref ? ["play", "needle", "make"] : ["play", "needle"]),
    [makeHref],
  );

  return (
    <div
      className="roll"
      data-playback={state.kind}
      data-stage={current ?? ""}
      data-step={state.kind === "rolling" ? state.step : ""}
      data-hero={hero}
      data-sounding={playing}
      data-audio={load}
      data-reduced={reduced}
    >
      {load === "ready" ? (
        <Disc
          blocks={blocks}
          lengths={lengths}
          playable={playable}
          peaks={peaks}
          live={live}
          playing={playing}
          reduced={reduced}
          focus={hero}
          onScrubStart={(stage, offset) => act((e) => e.scrubStart(stage, offset))}
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

      <header className="bar">
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
        {makeHref ? (
          // A plain link, not Next's: this component is also bundled by the browser tests outside Next.
          <a href={makeHref} className="make-link">
            {copy.flip.makeLink}
          </a>
        ) : null}
        <ThemeToggle />
      </header>

      {coachOpen ? (
        <Coach
          steps={coachSteps}
          stages={stages}
          hero={hero}
          playing={playing}
          auditioning={state.kind === "auditioning"}
          onClose={() => setCoachOpen(false)}
        />
      ) : null}

      <div className="viewport" ref={viewportEl}>
        <div
          className="sheet"
          data-placed={placed}
          ref={sheet}
          style={{ transform: `translateY(${shift}px)` }}
        >
          <p className="lead">{copy.roll.lead}</p>
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

      <div className="notes" ref={notesEl}>
        <p
          className="status"
          role="status"
          data-empty={status === "" || (marking && markCut !== null)}
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
        <div className="mark-bar" role="group" aria-label={copy.mark.toggle}>
          <button
            type="button"
            className="primary"
            onClick={() => {
              const id = blocks[mark.stage]?.id;
              if (id) openMake?.(id, markCut);
            }}
          >
            {copy.mark.flipPart} · {markLabel}
          </button>
          <button type="button" onClick={() => setMark(null)}>
            {copy.mark.clear}
          </button>
        </div>
      ) : null}

      <div className="controls" role="group" aria-label={copy.controls.label}>
        <button type="button" disabled={disabled} onClick={() => act((e) => e.previous())}>
          <span aria-hidden="true">←</span>
          <span className="visually-hidden">{copy.controls.previous}</span>
        </button>
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => act((e) => (playing ? e.pause() : e.play()))}
        >
          {playing ? copy.controls.pause : reduced ? copy.controls.playAll : copy.controls.play}
        </button>
        <button type="button" disabled={disabled} onClick={() => act((e) => e.next())}>
          <span aria-hidden="true">→</span>
          <span className="visually-hidden">{copy.controls.next}</span>
        </button>
      </div>

      {apiUrl ? (
        <ReportDialog target={reporting} apiUrl={apiUrl} onClose={() => setReporting(null)} />
      ) : null}
      <Footer onHow={() => setCoachOpen(true)} />
    </div>
  );
}
