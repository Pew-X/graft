"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createApi, fetchChain } from "../lib/api/chain.ts";
import { copy, fill } from "../lib/copy.ts";
import { checkFlip, renderFlip } from "../lib/make/flip.ts";
import { type Cut, outputFrames, refusal, seconds } from "../lib/make/cut.ts";
import { Previewer } from "../lib/make/preview.ts";
import { RENDERER_PATH, loadRenderer, type Renderer } from "../lib/make/renderer.ts";
import type { Sound } from "../lib/make/sounds.ts";
import { entryAt, indexOf, parseSpeed, step, STOPS } from "../lib/make/speed.ts";
import { useAsync } from "../lib/make/use-async.ts";
import { fetchPcm } from "../lib/roll/pcm.ts";
import { describeSpeed } from "../lib/roll/speed.ts";
import { CutEditor } from "./CutEditor.tsx";
import { SoundPicker } from "./SoundPicker.tsx";

/** The first thing heard is a flip, not the sound unchanged: up a fifth. */
const DEFAULT_SPEED = { p: 3, q: 2 };
const LONGEST_CUT = 480_000;

/** Where the audio of the sound being flipped comes from. */
type Origin = { kind: "shipped"; sound: Sound } | { kind: "live"; id: string };

type Start = { cut: string | null; speed: string | null };

function parseCut(text: string | null): Cut | null {
  const m = text?.match(/^(\d{1,7})-(\d{1,7})$/);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

// One renderer for the page: fetched once and instantiated once.
let rendererOnce: Promise<Renderer> | null = null;
function renderer(): Promise<Renderer> {
  rendererOnce ??= fetch(RENDERER_PATH)
    .then((r) => {
      if (!r.ok) throw new Error(`the renderer was answered with ${r.status}`);
      return r.arrayBuffer();
    })
    .then(loadRenderer)
    .catch((error: unknown) => {
      rendererOnce = null; // a failed fetch may be tried again
      throw error;
    });
  return rendererOnce;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("abandoned", "AbortError"));
    });
  });

/** The make flow: pick a sound, cut it, turn the one speed control, hear the result as it moves. */
export function Make({
  curated,
  flips,
  from,
  start,
  apiUrl,
}: {
  curated: readonly Sound[];
  flips: readonly Sound[];
  from: string | null;
  start: Start;
  apiUrl: string;
}) {
  const router = useRouter();
  const known = useMemo(
    () => [...curated, ...flips].find((s) => s.id === from) ?? null,
    [curated, flips, from],
  );
  const [picked, setPicked] = useState<Sound | null>(null);
  const origin: Origin | null = picked
    ? { kind: "shipped", sound: picked }
    : known
      ? { kind: "shipped", sound: known }
      : from
        ? { kind: "live", id: from }
        : null;

  const engine = useAsync("renderer", renderer);

  const path = origin?.kind === "shipped" ? origin.sound.audioPath : null;
  const liveId = origin?.kind === "live" ? origin.id : null;
  const sound = useAsync(path ?? (liveId === null ? null : `live:${liveId}`), async (signal) => {
    if (path !== null) return fetchPcm(path, signal);
    const chain = await fetchChain(createApi(apiUrl), liveId ?? "");
    const last = chain?.stages.at(-1);
    if (!last || last.state !== "available") throw new GoneError();
    return fetchPcm(last.audio.url, signal);
  });

  return (
    <div className="make" data-testid="make">
      <p className="kicker">{copy.make.kicker}</p>
      {origin === null ? (
        <SoundPicker curated={curated} flips={flips} onChoose={setPicked} />
      ) : sound.status === "ready" ? (
        <Editor
          key={origin.kind === "shipped" ? origin.sound.id : origin.id}
          title={origin.kind === "shipped" ? origin.sound.title : null}
          samples={sound.value}
          engine={engine.status === "ready" ? engine.value : null}
          engineFailed={engine.status === "failed"}
          start={start}
          onChange={() => {
            // Back to the list. A sound named in the link is forgotten with it.
            if (from) router.push("/make");
            else setPicked(null);
          }}
        />
      ) : (
        <p className="notice" role="status">
          {sound.status === "failed"
            ? sound.error instanceof GoneError
              ? copy.make.pick.gone
              : copy.make.pick.failed
            : copy.make.pick.loading}
        </p>
      )}
      <p className="local">{copy.make.local}</p>
    </div>
  );
}

class GoneError extends Error {}

function Editor({
  title,
  samples,
  engine,
  engineFailed,
  start,
  onChange,
}: {
  title: string | null;
  samples: Int16Array;
  engine: Renderer | null;
  engineFailed: boolean;
  start: Start;
  onChange: () => void;
}) {
  const frames = samples.length;
  const [cut, setCut] = useState<Cut>(
    () => parseCut(start.cut) ?? { start: 0, end: Math.min(frames, LONGEST_CUT) },
  );
  const [stop, setStop] = useState<number>(() => {
    const given = parseSpeed(start.speed);
    return indexOf((given ?? DEFAULT_SPEED).p, (given ?? DEFAULT_SPEED).q);
  });
  const [listening, setListening] = useState(false);
  const [previewer] = useState(
    () =>
      new Previewer(
        () =>
          (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext) as
            (new (options?: { sampleRate?: number }) => never) | undefined,
      ),
  );

  const { p, q, cents } = entryAt(stop);
  const speed = describeSpeed(p, q);
  const problem = checkFlip(samples, { cut, p, q });
  const outLength = problem ? null : outputFrames(cut.end - cut.start, p, q);

  const made = useAsync(
    engine === null || problem !== null ? null : `${frames}:${cut.start}-${cut.end}:${p}/${q}`,
    async (signal) => {
      await wait(60, signal); // a drag asks for many renders; only the last is made
      return renderFlip(engine as Renderer, samples, { cut, p, q });
    },
  );
  // Between two renders the last good one stays, so the button and the sound do not flicker.
  const latest =
    made.status === "ready" ? made.value : made.status === "loading" ? made.previous : undefined;
  const ready = latest?.ok ? latest : null;

  useEffect(() => {
    if (listening && ready) void previewer.play(ready.samples).catch(() => setListening(false));
    else previewer.stop();
  }, [previewer, listening, ready]);
  useEffect(() => () => previewer.stop(), [previewer]);

  // Any gesture on a control starts the preview and keeps it going as the control moves.
  const touch = useCallback(() => {
    void previewer.unlock().catch(() => undefined);
    setListening(true);
  }, [previewer]);

  const direction = cents > 0 ? "up" : cents < 0 ? "down" : "src";
  const interval = speed.approximate
    ? fill(copy.make.speed.approximate, { interval: speed.interval })
    : speed.interval;

  return (
    <>
      <div className="stage-head">
        {title ? (
          <h2 className="slab" data-k="src" data-dye="0">
            <span className="slab-text">{title}</span>
          </h2>
        ) : null}
        <button type="button" className="quiet-link" onClick={onChange}>
          {copy.make.pick.change}
        </button>
      </div>

      <section className="panel" aria-labelledby="cut-label">
        <h3 id="cut-label" className="kicker">
          {copy.make.cut.label} <span className="gloss">{copy.make.cut.gloss}</span>
        </h3>
        <CutEditor samples={samples} cut={cut} onChange={setCut} onTouch={touch} />
      </section>

      <section className="panel" aria-labelledby="speed-label">
        <h3 id="speed-label" className="kicker">
          {copy.make.speed.label} <span className="gloss">{copy.make.speed.gloss}</span>
        </h3>
        <div className="speed-readout" data-k={direction} aria-hidden="true">
          <span className="percent">{speed.percent}</span>
          <span className="interval">{interval}</span>
        </div>
        <div className="speed-control">
          <button
            type="button"
            className="nudge"
            aria-label={copy.make.speed.slower}
            onClick={() => {
              touch();
              setStop((i) => step(i, -1));
            }}
          >
            −
          </button>
          <input
            type="range"
            min={0}
            max={STOPS - 1}
            step={1}
            value={stop}
            aria-label={copy.make.speed.label}
            aria-valuetext={fill(copy.make.speed.value, {
              percent: speed.percent,
              interval: speed.interval,
            })}
            onChange={(e) => {
              touch();
              setStop(Number(e.target.value));
            }}
          />
          <button
            type="button"
            className="nudge"
            aria-label={copy.make.speed.faster}
            onClick={() => {
              touch();
              setStop((i) => step(i, 1));
            }}
          >
            +
          </button>
        </div>
      </section>

      <section
        className="panel result"
        aria-labelledby="result-label"
        data-output-hash={ready?.hash ?? ""}
        data-output-frames={ready?.samples.length ?? ""}
      >
        <h3 id="result-label" className="kicker">
          {copy.make.result.label}
        </h3>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={problem !== null || ready === null}
            aria-describedby="why-not"
            onClick={() => {
              if (listening) setListening(false);
              else touch();
            }}
          >
            {listening ? copy.make.hear.pause : copy.make.hear.play}
          </button>
          <p id="why-not" className="refusal" role="status">
            {problem
              ? refusal(problem)
              : engineFailed
                ? copy.make.renderer.failed
                : engine === null
                  ? copy.make.renderer.loading
                  : outLength !== null
                    ? fill(copy.make.result.comesOut, { length: seconds(outLength) })
                    : ""}
          </p>
        </div>
        {ready ? (
          <details className="details">
            <summary>{copy.details.summary}</summary>
            <dl>
              <div>
                <dt>{copy.make.result.hash}</dt>
                <dd>
                  <code>{ready.hash}</code> <em>{copy.make.result.hashGloss}</em>
                </dd>
              </div>
            </dl>
          </details>
        ) : null}
      </section>
    </>
  );
}
