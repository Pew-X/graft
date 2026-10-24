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
import { peaksOf } from "../lib/record/disc.ts";
import { startTelemetry } from "../lib/telemetry/browser.ts";
import type { Telemetry } from "../lib/telemetry/telemetry.ts";
import type { Loader } from "../lib/roll/audio.ts";
import type { Block } from "../lib/roll/view.ts";
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
  apiUrl,
}: {
  blocks: readonly Block[];
  load: Loader;
  /** The chain goes back further than the page follows. */
  truncated?: boolean;
  /** Where to send best-effort counts (the service's events address); none, no counts. */
  reportTo?: string | undefined;
  /** Go to the make flow for a stage. Absent where the roll is shown without the site around it. */
  openMake?: ((id: string) => void) | undefined;
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
  const place = useCallback((): void => {
    const node = nodes.current[hero];
    if (!node) return;
    const h = window.innerHeight;
    const portrait = window.innerWidth < h * 0.9;
    // Landscape: the stage is centred a little above the middle. Portrait: it starts below the header.
    // A tall stage starts just under the header instead of being pushed up out of sight.
    const top = portrait ? Math.max(h * 0.12, 96) : Math.max(72, h * 0.46 - node.offsetHeight / 2);
    setShift(Math.round(top - node.offsetTop));
  }, [hero]);
  useLayoutEffect(() => {
    place();
    const settle = requestAnimationFrame(() => setPlaced(true));
    const el = sheet.current;
    if (!el) return () => cancelAnimationFrame(settle);
    // Fonts arriving, a stage's details opening, the window changing: the roll finds its place again.
    const watch = new ResizeObserver(place);
    watch.observe(el);
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

  const status =
    notice ||
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
        {openMake ? (
          // A plain link, not Next's: this component is also bundled by the browser tests outside Next.
          <a href="/make" className="make-link">
            {copy.flip.makeLink}
          </a>
        ) : null}
        <ThemeToggle />
      </header>

      <div className="viewport">
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

      <div className="notes">
        <p className="status" role="status" data-empty={status === ""}>
          {status}
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
        {state.kind === "idle" ? (
          <div className="how" data-testid="how-it-works">
            <p>{copy.hint.how1}</p>
            <p>{openMake ? copy.hint.how2 : copy.hint.how2Plain}</p>
          </div>
        ) : null}
        {truncated ? <p className="hint">{copy.states.truncated}</p> : null}
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>

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
      <Footer />
    </div>
  );
}
