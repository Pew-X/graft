"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { peaksOf } from "../lib/record/geometry.ts";
import { fetchPcm } from "../lib/roll/pcm.ts";
import type { Block } from "../lib/roll/view.ts";
import { CreditBlock, EndBlock } from "./CreditBlock.tsx";
import { Record, type Live } from "./Record.tsx";

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
 * no audio context exists, until the first tap. The audio is fetched as static files; the API is never
 * asked for the seeded chain.
 */
export function RollPlayer({ blocks }: { blocks: readonly Block[] }) {
  const [load, setLoad] = useState<Load>(() =>
    blocks.some((b) => b.audioPath === null) ? "failed" : "loading",
  );
  const [state, setState] = useState<State>(idle);
  const [notice, setNotice] = useState("");
  const [reduced, setReduced] = useState(false);
  const [peaks, setPeaks] = useState<number[][]>([]);
  const audio = useRef<LazyAudio | null>(null);
  const engine = useRef<Promise<Engine | null> | null>(null);
  const engineNow = useRef<Engine | null>(null);
  const reducedRef = useRef(false);
  const cleanup = useRef<Array<() => void>>([]);
  const nodes = useRef<Array<HTMLElement | null>>([]);

  const lengths = useMemo(() => blocks.map((b) => b.seconds), [blocks]);
  const stages = blocks.length;
  const current = currentStage(state, stages);
  const playing = isSounding(state);

  // Fetch every stage's audio as a static file. Nothing is decoded or played yet.
  useEffect(() => {
    const abort = new AbortController();
    const paths = blocks.map((b) => b.audioPath);
    if (paths.some((p) => p === null)) return;
    Promise.all(paths.map((p) => fetchPcm(p as string, abort.signal)))
      .then((pcm) => {
        audio.current = new LazyAudio(audioConstructor, pcm);
        setPeaks(pcm.map((samples) => peaksOf(samples, 96)));
        setLoad("ready");
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoad("failed");
      });
    return () => abort.abort();
  }, [blocks]);

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

  // Leaving the page stops everything.
  useEffect(() => {
    const undo = cleanup.current;
    return () => {
      void engine.current?.then((e) => e?.routeChange());
      for (const fn of undo.splice(0)) fn();
    };
  }, []);

  // The roll follows the audio: the current block is brought to the middle, unless motion is reduced.
  useEffect(() => {
    if (current === null || reduced) return;
    nodes.current[current]?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [current, reduced]);

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
        ? copy.hint.loadFailed
        : state.kind === "idle"
          ? copy.hint.locked
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

  return (
    <div
      className="roll"
      data-playback={state.kind}
      data-stage={current ?? ""}
      data-step={state.kind === "rolling" ? state.step : ""}
      data-sounding={playing}
      data-audio={load}
      data-reduced={reduced}
    >
      <div className="column">
        <p className="hint">{copy.hint.order}</p>
        <p className="status" role="status">
          {status}
        </p>
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>

        <ol className="blocks" aria-label={copy.roll.label}>
          {blocks.map((block) => (
            <CreditBlock
              key={block.id}
              block={block}
              total={stages}
              current={current === block.index}
              playing={playing && state.kind === "auditioning" && state.stage === block.index}
              disabled={disabled}
              onPlay={() => act((e) => e.tapStage(block.index))}
              onFlip={() => setNotice(copy.flip.closed)}
              nodeRef={(node) => {
                nodes.current[block.index] = node;
              }}
            />
          ))}
          <EndBlock onFlip={() => setNotice(copy.flip.closed)} />
        </ol>
      </div>

      <div className="dock">
        {load === "ready" ? (
          <Record
            blocks={blocks}
            peaks={peaks}
            live={live}
            playing={playing}
            onScrubStart={(stage, offset) => act((e) => e.scrubStart(stage, offset))}
            onScrubMove={(stage, offset) => engineNow.current?.scrubMove(stage, offset)}
            onScrubEnd={() => {
              engineNow.current?.scrubEnd();
              // Some phones only unlock audio on the release of a touch, not its start.
              void audio.current?.unlock().catch(() => undefined);
            }}
          />
        ) : null}
        <div className="controls" role="group" aria-label={copy.controls.label}>
          <button type="button" disabled={disabled} onClick={() => act((e) => e.previous())}>
            {copy.controls.previous}
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
            {copy.controls.next}
          </button>
        </div>
      </div>
    </div>
  );
}
