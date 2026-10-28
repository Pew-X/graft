"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createApi, fetchChain } from "../lib/api/chain.ts";
import { copy, fill } from "../lib/copy.ts";
import { checkFlip, renderFlip } from "../lib/make/flip.ts";
import { type Cut, LIMITS, outputFrames, refusal, seconds } from "../lib/make/cut.ts";
import { Previewer } from "../lib/make/preview.ts";
import { browserRenderer } from "../lib/make/browser-renderer.ts";
import type { Renderer } from "../lib/make/renderer.ts";
import type { Sound } from "../lib/make/sounds.ts";
import { entryAt, indexOf, parseSpeed, step, STOPS } from "../lib/make/speed.ts";
import { next as nextGuide, replayAt, type MakeEvent, type MakePhase } from "../lib/coach/make.ts";
import { readMade, writeMade } from "../lib/coach/seen.ts";
import { type Async, useAsync } from "../lib/make/use-async.ts";
import { fetchPcm } from "../lib/roll/pcm.ts";
import { describeSpeed } from "../lib/roll/speed.ts";
import { CutEditor } from "./CutEditor.tsx";
import { type Features, readFeatures } from "../lib/own/features.ts";
import { type Basis, DECLARATION_TEXT, sourceBody } from "../lib/own/source.ts";
import { OwnSound } from "./OwnSound.tsx";
import { PublishStep } from "./PublishStep.tsx";
import { MakeGuide } from "./MakeGuide.tsx";
import { TrimStep } from "./TrimStep.tsx";
import { SoundPicker } from "./SoundPicker.tsx";
import { Steps } from "./Steps.tsx";

/** The first thing heard is a flip, not the sound unchanged: up a fifth. */
const DEFAULT_SPEED = { p: 3, q: 2 };

/** Where the audio of the sound being flipped comes from. */
type Origin = { kind: "shipped"; sound: Sound } | { kind: "live"; id: string };

type Start = { cut: string | null; speed: string | null };

function parseCut(text: string | null): Cut | null {
  const m = text?.match(/^(\d{1,7})-(\d{1,7})$/);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

// One renderer for the page: fetched once and instantiated once.
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
  // The maker's own sound: in memory only. `toTrim` is one longer than a source may be.
  const [own, setOwn] = useState<Int16Array | null>(null);
  const [toTrim, setToTrim] = useState<Int16Array | null>(null);
  const origin: Origin | null = picked
    ? { kind: "shipped", sound: picked }
    : known
      ? { kind: "shipped", sound: known }
      : from
        ? { kind: "live", id: from }
        : null;

  // Asked when the page opens at the picker (a page opened on a stage, `?from=`, has no own-sound block
  // and asks nothing), so the own-sound block can say up front whether publishing a sound of one's own
  // is open and the editor can use the same answer: nothing more than this one read leaves the device
  // before a publish. If that read failed, choosing a sound of one's own asks once more. A service that
  // cannot be asked says nothing.
  const [featuresTry, setFeaturesTry] = useState(0);
  const features = useAsync(from === null ? `features:${featuresTry}` : null, (signal) =>
    readFeatures(apiUrl, signal),
  );

  const [engineTry, setEngineTry] = useState(0);
  const engine = useAsync(`renderer:${engineTry}`, browserRenderer);

  const path = origin?.kind === "shipped" ? origin.sound.audioPath : null;

  // The hints for making a flip: one line at a time under the step markers, until the visitor has been
  // through them once (a note in the browser) or skips them. The slot keeps its height from the moment it
  // is shown.
  const [guide, setGuide] = useState<MakePhase>("done");
  const [slot, setSlot] = useState(false);
  const send = useCallback((event: MakeEvent) => setGuide((p) => nextGuide(p, event)), []);
  const skipGuide = useCallback(() => send("skipped"), [send]);
  const fadedGuide = useCallback(() => send("faded"), [send]);
  useEffect(() => {
    // read after the page is up, in a microtask: the server cannot know what the browser has stored
    queueMicrotask(() => {
      if (readMade()) return;
      setGuide("pick");
      setSlot(true);
    });
  }, []);
  useEffect(() => {
    if (guide === "done" && slot) writeMade();
  }, [guide, slot]);
  const liveId = origin?.kind === "live" ? origin.id : null;
  const sound = useAsync(path ?? (liveId === null ? null : `live:${liveId}`), async (signal) => {
    if (path !== null) return fetchPcm(path, signal);
    const chain = await fetchChain(createApi(apiUrl), liveId ?? "");
    const last = chain?.stages.at(-1);
    if (!last || last.state !== "available") throw new GoneError();
    return fetchPcm(last.audio.url, signal);
  });

  const editing =
    (origin !== null && sound.status === "ready") || (origin === null && own !== null);
  const picking = origin === null && own === null && toTrim === null;
  useEffect(() => {
    if (guide === "pick" && editing) queueMicrotask(() => send("picked"));
  }, [guide, editing, send]);
  // which line fits what is on the screen now; none while a sound loads or is being trimmed
  const line =
    guide === "done" ? null : guide === "pick" ? (picking ? "pick" : null) : editing ? guide : null;
  // The line sits under the step markers, which the editor draws once it is up and this page draws before.
  const guideSlot = slot ? <MakeGuide line={line} onSkip={skipGuide} onFaded={fadedGuide} /> : null;

  return (
    <div className="make" data-testid="make">
      <div className="make-bar">
        <Link href="/" className="back">
          {copy.make.home}
        </Link>
        <p className="kicker">{copy.make.kicker}</p>
        <button
          type="button"
          className="back how"
          onClick={() => {
            setSlot(true);
            setGuide(replayAt(editing));
          }}
        >
          <span aria-hidden="true">{copy.footer.howMark}</span> {copy.make.guide.how}
        </button>
      </div>
      {(origin === null && own !== null && toTrim === null) ||
      (origin !== null && sound.status === "ready") ? null : (
        <>
          <Steps current={origin === null ? 1 : 2} />
          {guideSlot}
        </>
      )}
      {origin === null && own === null && toTrim === null ? (
        <p className="lede" data-testid="make-intro">
          {copy.make.intro}
        </p>
      ) : null}
      {origin === null && toTrim !== null ? (
        <TrimStep
          samples={toTrim}
          onUse={(part) => {
            setOwn(part);
            setToTrim(null);
          }}
          onCancel={() => setToTrim(null)}
        />
      ) : origin === null && own !== null ? (
        <Editor
          key="own"
          title={copy.own.title}
          own
          features={features}
          parentId={null}
          apiUrl={apiUrl}
          samples={own}
          engine={engine.status === "ready" ? engine.value : null}
          engineFailed={engine.status === "failed"}
          onRetryEngine={() => setEngineTry((n) => n + 1)}
          start={start}
          onGuide={send}
          guideSlot={guideSlot}
          onChange={() => setOwn(null)}
        />
      ) : origin === null ? (
        <SoundPicker curated={curated} flips={flips} onChoose={setPicked}>
          <OwnSound
            uploads={features.status === "ready" ? features.value.uploads : null}
            onSound={(samples, needsTrim) => {
              if (features.status === "failed") setFeaturesTry((n) => n + 1);
              if (needsTrim) setToTrim(samples);
              else setOwn(samples);
            }}
          />
        </SoundPicker>
      ) : sound.status === "ready" ? (
        <Editor
          key={origin.kind === "shipped" ? origin.sound.id : origin.id}
          title={origin.kind === "shipped" ? origin.sound.title : null}
          own={false}
          features={features}
          parentId={origin.kind === "shipped" ? origin.sound.id : origin.id}
          apiUrl={apiUrl}
          samples={sound.value}
          engine={engine.status === "ready" ? engine.value : null}
          engineFailed={engine.status === "failed"}
          onRetryEngine={() => setEngineTry((n) => n + 1)}
          start={start}
          onGuide={send}
          guideSlot={guideSlot}
          onChange={() => {
            // Back to the list. A sound named in the link is forgotten with it.
            if (from) router.push("/make");
            else setPicked(null);
          }}
        />
      ) : (
        <div>
          <p className="notice" role="status">
            {sound.status === "failed"
              ? sound.error instanceof GoneError
                ? copy.make.pick.gone
                : copy.make.pick.failed
              : copy.make.pick.loading}
          </p>
          {sound.status === "failed" ? (
            <div className="actions">
              <button
                type="button"
                className="pill"
                onClick={() => {
                  if (from) router.push("/make");
                  else setPicked(null);
                }}
              >
                {copy.make.pick.change}
              </button>
              {sound.error instanceof GoneError ? null : (
                <button type="button" className="pill" onClick={() => window.location.reload()}>
                  {copy.publish.retry}
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
      <p className="local">{copy.make.local}</p>
    </div>
  );
}

class GoneError extends Error {}

function Editor({
  title,
  own,
  features,
  parentId,
  apiUrl,
  samples,
  engine,
  engineFailed,
  onRetryEngine,
  start,
  onGuide,
  guideSlot,
  onChange,
}: {
  title: string | null;
  /** The maker's own sound, not yet published: it must be published as a source before it can be flipped. */
  own: boolean;
  /** What the service said is open, asked once by the page; it is only acted on for a sound of one's own. */
  features: Async<Features>;
  parentId: string | null;
  apiUrl: string;
  samples: Int16Array;
  engine: Renderer | null;
  engineFailed: boolean;
  onRetryEngine: () => void;
  start: Start;
  /** What the visitor did that the make flow's hints follow. */
  onGuide: (event: MakeEvent) => void;
  /** The hint line, drawn under the step markers. */
  guideSlot: ReactNode;
  onChange: () => void;
}) {
  const frames = samples.length;
  const [cut, setCut] = useState<Cut>(
    () => parseCut(start.cut) ?? { start: 0, end: Math.min(frames, LIMITS.maxCutFrames) },
  );
  const [stop, setStop] = useState<number>(() => {
    const given = parseSpeed(start.speed);
    return indexOf((given ?? DEFAULT_SPEED).p, (given ?? DEFAULT_SPEED).q);
  });
  const [listening, setListening] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [publishingSource, setPublishingSource] = useState(false);
  const [basis, setBasis] = useState<Basis>("own_recording");
  const [confirmed, setConfirmed] = useState(false);
  const flipParent = own ? sourceId : parentId;
  const closedWhy =
    !own || features.status !== "ready"
      ? null
      : !features.value.publishing
        ? copy.own.closed
        : !features.value.uploads
          ? copy.own.off
          : null;
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
  // What may be published: the render of exactly this cut and speed, not the one before it.
  const current = made.status === "ready" && made.value.ok ? made.value : null;

  useEffect(() => {
    if (listening && ready) void previewer.play(ready.samples).catch(() => setListening(false));
    else previewer.stop();
  }, [previewer, listening, ready]);
  useEffect(() => () => previewer.close(), [previewer]);

  // Any gesture on a control starts the preview and keeps it going as the control moves.
  const touch = useCallback(() => {
    void previewer.unlock().catch(() => undefined);
    setListening(true);
    onGuide("heard");
  }, [previewer, onGuide]);

  const direction = cents > 0 ? "up" : cents < 0 ? "down" : "src";
  const interval = speed.approximate
    ? fill(copy.make.speed.approximate, { interval: speed.interval })
    : speed.interval;

  return (
    <>
      <Steps current={publishing || publishingSource ? 3 : 2} />
      {guideSlot}
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
        <CutEditor
          samples={samples}
          cut={cut}
          onChange={(c) => {
            setCut(c);
            onGuide("changed");
          }}
          onTouch={touch}
        />
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
              onGuide("changed");
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
              onGuide("changed");
            }}
          />
          <button
            type="button"
            className="nudge"
            aria-label={copy.make.speed.faster}
            onClick={() => {
              touch();
              setStop((i) => step(i, 1));
              onGuide("changed");
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
          {publishing ? null : (
            <button
              type="button"
              className="pill"
              disabled={problem !== null || current === null || flipParent === null}
              aria-describedby="why-not"
              onClick={() => {
                setPublishing(true);
                onGuide("shared");
              }}
            >
              {copy.publish.open}
            </button>
          )}
          {own && sourceId === null ? (
            <button
              type="button"
              className="pill"
              disabled={publishingSource || closedWhy !== null}
              aria-describedby="own-why"
              onClick={() => setPublishingSource(true)}
            >
              {copy.own.publishSource}
            </button>
          ) : null}
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
          {engineFailed && problem === null ? (
            <button type="button" className="pill" onClick={onRetryEngine}>
              {copy.publish.retry}
            </button>
          ) : null}
        </div>
        {own ? (
          <p id="own-why" className="hint">
            {closedWhy ?? (sourceId === null ? copy.own.flipNote : copy.own.sourceDone)}
          </p>
        ) : null}
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
      {own && publishingSource ? (
        <PublishStep
          signature="source"
          path="/v1/sources"
          heading={copy.own.sourceHeading}
          statement={copy.own.sourcePublic}
          gate={confirmed}
          gateWhy={copy.own.confirm.replace("{statement}", DECLARATION_TEXT)}
          buildBody={({ title, author, retryKey }) =>
            sourceBody({ samples, title, author, retryKey, basis })
          }
          apiUrl={apiUrl}
          onClose={() => setPublishingSource(false)}
          onPublished={setSourceId}
        >
          <fieldset className="declaration">
            <legend>{copy.own.basis}</legend>
            {(["own_recording", "right_to_share"] as const).map((b) => (
              <label key={b} className="choice">
                <input
                  type="radio"
                  name="basis"
                  checked={basis === b}
                  onChange={() => setBasis(b)}
                />
                <span>{b === "own_recording" ? copy.own.basisOwn : copy.own.basisRight}</span>
              </label>
            ))}
            <label className="choice">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{fill(copy.own.confirm, { statement: DECLARATION_TEXT })}</span>
            </label>
            <p className="hint">{copy.own.declared}</p>
          </fieldset>
        </PublishStep>
      ) : null}
      {publishing && flipParent !== null ? (
        <PublishStep
          signature={`${flipParent}:${cut.start}-${cut.end}:${p}/${q}`}
          buildBody={({ title, author, retryKey }) => ({
            parent_id: flipParent,
            cut: { start: cut.start, end: cut.end },
            speed: { p, q },
            title,
            author,
            retry_key: retryKey,
            ...(current ? { preview_hash: current.hash } : {}),
          })}
          gate={current !== null}
          gateWhy={problem ? refusal(problem) : copy.make.result.updating}
          apiUrl={apiUrl}
          onClose={() => setPublishing(false)}
        />
      ) : null}
    </>
  );
}
