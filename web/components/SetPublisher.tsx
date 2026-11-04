"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { type Outcome, publishWithRetries } from "../lib/publish/client.ts";
import { NAME_MAX, hintFor } from "../lib/publish/hints.ts";
import { forgetKey, keepKey, keptKeys } from "../lib/publish/keep.ts";
import { wireFor } from "../lib/publish/wire.ts";
import { hintText, refusalText } from "../lib/publish/words.ts";
import { markPublished, readBook, rename } from "../lib/sketch/book.ts";
import { leasedElsewhere, refreshLease, releaseLease, takeLease } from "../lib/sketch/lease.ts";
import { type ItemState, type StopWhy, planSet, runSet } from "../lib/sketch/set.ts";
import type { Sketch } from "../lib/sketch/sketch.ts";
import { cleanTitle } from "../lib/sketch/title.ts";
import { announceSketchChange, sketchStorage, useSketchBook } from "./useSketchBook.ts";
import { useSketchSet } from "./useSketchSet.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Renderer = (
  sketch: Sketch,
) => Promise<{ ok: true; hash: string } | { ok: false; why: string }>;

function whyStopped(why: StopWhy): string {
  const s = copy.sketch.set.stoppedBecause;
  switch (why.kind) {
    case "refusal":
      return refusalText(why.refusal);
    case "gaveUp":
      return fill(s.gaveUp, { why: copy.publish.gaveUp[why.why].replace("{attempts}", "4") });
    case "mismatch":
      return s.mismatch;
    case "render":
      return fill(s.render, { why: why.why });
    case "cancelled":
      return s.cancelled;
  }
}

function stateText(state: ItemState): string {
  const t = copy.sketch.set.state;
  switch (state.status) {
    case "waiting":
      return t.waiting;
    case "publishing":
      return state.attempt > 1 ? fill(t.trying, { n: state.attempt, of: state.of }) : t.publishing;
    case "published":
      return state.created ? t.published : t.already;
    case "skipped":
      return state.why === "parent" ? t.skippedParent : refusalText(state.why);
    case "stopped":
      return t.stopped;
  }
}

/**
 * "publish these": the chosen sketches are published in order, one after another, through the publish call
 * the service already has, and everything ends on one screen with every link and every key. It does not hold
 * a new endpoint or a new kind of request: each sketch is an ordinary publication with its own retry key, so
 * a set that stops (a limit, the network, a refused title) is resumed from where it was and publishes nothing
 * twice. A manage key is written to this browser the moment it arrives, before anything else changes.
 */
export function SetPublisher({
  apiUrl,
  render,
  onStarted,
  notes = false,
}: {
  apiUrl: string;
  /** The service has notes, so each sketch's note is sent with it. */
  notes?: boolean;
  /** The visitor started a set: the make guide's last lines follow it. */
  onStarted?: () => void;
  /** The hash of the sound a sketch renders to here: sent as the preview, so a differing render is caught. */
  render: Renderer;
}) {
  const uid = useId();
  const book = useSketchBook();
  const { chosen, setAuthor, clear } = useSketchSet();
  const [tabId] = useState(() => `tab-${crypto.randomUUID()}`);
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<ReadonlyMap<string, ItemState>>(new Map());
  const [keys, setKeys] = useState<ReadonlyMap<string, string>>(new Map());
  const [stopWhy, setStopWhy] = useState<StopWhy | null>(null);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState("");
  const [keepAll, setKeepAll] = useState(true);
  const [leaveWarned, setLeaveWarned] = useState(false);
  const [keysCopied, setKeysCopied] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const [title, setTitle] = useState("");
  const [titleProblem, setTitleProblem] = useState("");
  const abort = useRef<AbortController | null>(null);

  const plan = useMemo(() => planSet(book, chosen.ids), [book, chosen.ids]);
  const authorHint = chosen.author === "" ? null : hintFor(chosen.author, NAME_MAX);
  const authorOk =
    chosen.author.trim() !== "" && (authorHint === null || authorHint.kind === "adjusted");

  // a lease held by another tab's run is seen without a reload
  useEffect(() => {
    const look = (): void =>
      setElsewhere(!running && leasedElsewhere(sketchStorage(), tabId, Date.now()));
    look();
    const timer = window.setInterval(look, 3_000);
    window.addEventListener("storage", look);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", look);
    };
  }, [running, tabId]);
  useEffect(
    () => () => {
      abort.current?.abort();
      releaseLease(sketchStorage(), tabId);
    },
    [tabId],
  );

  const go = async (): Promise<void> => {
    if (running || !authorOk || plan.order.length === 0) return;
    if (!takeLease(sketchStorage(), tabId, Date.now()).ok) {
      setElsewhere(true);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    onStarted?.();
    setRunning(true);
    setStopWhy(null);
    setStoppedAt(null);
    setTitleProblem("");
    const refresh = window.setInterval(
      () => refreshLease(sketchStorage(), tabId, Date.now()),
      10_000,
    );
    try {
      const result = await runSet(plan.order, {
        readBook: () => readBook(sketchStorage()),
        render,
        post: async (body, onAttempt, signal): Promise<Outcome> => {
          const outcome = await publishWithRetries(wireFor(apiUrl), body, {
            sleep,
            onAttempt,
            signal,
          });
          // a service that did not answer is often one that was asleep: ask the site to wake it
          if (outcome.kind === "gaveUp" && outcome.why === "network")
            void fetch("/api/wake", { method: "POST" }).catch(() => undefined);
          return outcome;
        },
        keepKey: (id, key) => keepKey(sketchStorage(), id, key),
        holdsKey: (id) => id in keptKeys(sketchStorage()),
        markPublished: (sketchId, id) => {
          markPublished(sketchStorage(), sketchId, id);
          announceSketchChange();
        },
        author: chosen.author.trim(),
        notes,
        signal: controller.signal,
        // a resumed run adds to what the first showed, so the screen counts the whole set
        onUpdate: (next, got) => {
          setStates((was) => new Map([...was, ...next]));
          setKeys((was) => new Map([...was, ...got]));
        },
      });
      setStates((was) => new Map([...was, ...result.states]));
      setKeys((was) => new Map([...was, ...result.keys]));
      setStoppedAt(result.stoppedAt);
      const at = result.stoppedAt ? result.states.get(result.stoppedAt) : undefined;
      setStopWhy(at?.status === "stopped" ? at.why : null);
      if (result.stoppedAt === null) clear();
    } finally {
      window.clearInterval(refresh);
      releaseLease(sketchStorage(), tabId);
      setRunning(false);
    }
  };

  const published = [...states.entries()].filter(([, s]) => s.status === "published");
  const set = copy.sketch.set;
  if (chosen.ids.length === 0 && states.size === 0) {
    return (
      <section className="set-publisher" aria-labelledby={`${uid}-h`} data-testid="set-publisher">
        <h3 id={`${uid}-h`} className="kicker">
          {set.heading}
        </h3>
        <p className="hint">{set.intro}</p>
      </section>
    );
  }
  const total = states.size || plan.order.length;
  const doneCount = [...states.values()].filter(
    (s) => s.status === "published" || s.status === "skipped",
  ).length;
  const waiting = [...states.values()].filter(
    (s) => s.status === "waiting" || s.status === "stopped",
  ).length;
  const byId = new Map(book.sketches.map((s) => [s.id, s]));
  const titleOf = (id: string): string => byId.get(id)?.title ?? "";
  const stoppedSketch = stoppedAt ? byId.get(stoppedAt) : undefined;
  const titleRefused =
    stopWhy?.kind === "refusal" &&
    stopWhy.refusal.kind === "invalid" &&
    stopWhy.refusal.field === "title";

  return (
    <section className="set-publisher" aria-labelledby={`${uid}-h`} data-testid="set-publisher">
      <h3 id={`${uid}-h`} className="kicker">
        {set.heading}
      </h3>
      {states.size === 0 ? (
        <>
          <p className="public">{copy.publish.public}</p>
          <p className="notice">{copy.publish.noAccount}</p>
          <p>{fill(set.plan, { n: plan.order.length })}</p>
          <ol className="set-plan">
            {plan.order.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ol>
          {plan.pulledIn.length > 0 ? (
            <p className="hint">
              {fill(set.pulledIn, { titles: plan.pulledIn.map((s) => s.title).join(", ") })}
            </p>
          ) : null}
          {plan.leftOut.length > 0 ? (
            <p className="hint">{fill(set.leftOut, { max: 12, n: plan.leftOut.length })}</p>
          ) : null}
          {plan.alreadyPublished.length > 0 ? (
            <p className="hint">{fill(set.already, { n: plan.alreadyPublished.length })}</p>
          ) : null}
        </>
      ) : null}
      {states.size === 0 ? (
        <div className="field">
          <label htmlFor={`${uid}-author`}>
            {set.author} <span className="gloss">{copy.publish.nameGloss}</span>
          </label>
          <input
            id={`${uid}-author`}
            type="text"
            value={chosen.author}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={authorHint !== null && authorHint.kind !== "adjusted"}
            onChange={(e) => setAuthor(e.target.value)}
          />
          <p className="hint">{authorHint ? hintText(authorHint) : ""}</p>
        </div>
      ) : null}

      {states.size > 0 ? (
        <ol className="set-progress" aria-label={set.heading}>
          {[...states.entries()].map(([id, state]) => (
            <li key={id} data-status={state.status}>
              <span className="set-title">{titleOf(id)}</span>
              <span className="set-state" role="status">
                {stateText(state)}
              </span>
              {state.status === "published" && state.keyLost ? (
                <span className="notice" role="status">
                  {set.keyLost}
                </span>
              ) : null}
              {state.status === "published" && !state.keyKept && !state.keyLost ? (
                <span className="notice" role="status">
                  {set.keyNotKept}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <div className="actions">
        {running ? (
          <button type="button" className="pill" onClick={() => abort.current?.abort()}>
            {set.stop}
          </button>
        ) : states.size === 0 ? (
          <button
            type="button"
            className="primary"
            disabled={!authorOk || plan.order.length === 0 || elsewhere}
            onClick={() => void go()}
          >
            {fill(set.go, { n: plan.order.length })}
          </button>
        ) : waiting > 0 ? (
          <button
            type="button"
            className="primary"
            disabled={elsewhere || titleRefused}
            onClick={() => void go()}
          >
            {set.continue}
          </button>
        ) : null}
      </div>
      {elsewhere ? (
        <p className="notice" role="status">
          {set.elsewhere}
        </p>
      ) : null}
      {running ? (
        <p role="status" className="progress">
          {fill(set.running, { done: doneCount, total })}
        </p>
      ) : null}
      {states.size > 0 && !running ? (
        <div role="alert" className="problem" data-testid="set-summary">
          <p>{fill(set.summary, { published: published.length, waiting })}</p>
          {stopWhy ? <p>{whyStopped(stopWhy)}</p> : null}
          {waiting > 0 ? <p>{set.nothingLost}</p> : null}
        </div>
      ) : null}
      {titleRefused && stoppedSketch && !running ? (
        <form
          className="sketch-rename"
          onSubmit={(e) => {
            e.preventDefault();
            const cleaned = cleanTitle(title);
            if (!cleaned.ok) {
              setTitleProblem(
                copy.sketch.titleWhy[cleaned.rule]
                  .replace("{limit}", "60")
                  .replace("{detail}", cleaned.detail),
              );
              return;
            }
            rename(sketchStorage(), stoppedSketch.id, cleaned.value);
            announceSketchChange();
            setTitle("");
            setTitleProblem("");
            void go();
          }}
        >
          <label>
            <span>{fill(set.editTitle, { title: stoppedSketch.title })}</span>
            <input
              type="text"
              value={title}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <button type="submit" className="pill" disabled={title.trim() === ""}>
            {set.saveAndContinue}
          </button>
          <p role="status" className="hint">
            {titleProblem}
          </p>
        </form>
      ) : null}

      {published.length > 0 ? (
        <div className="set-result" data-testid="set-result">
          <h4 className="kicker">{set.result}</h4>
          <p className="hint">{set.resultIntro}</p>
          <ul className="set-links">
            {published.map(([sketchId, state]) => {
              const id = state.status === "published" ? state.id : "";
              const key = keys.get(id) ?? keptKeys(sketchStorage())[id] ?? null;
              return (
                <li key={sketchId}>
                  <span className="set-title">{titleOf(sketchId)}</span>
                  <a className="link" href={`/p/${id}`}>
                    {new URL(`/p/${id}`, window.location.href).href}
                  </a>
                  <a
                    className="pill"
                    href={`/make?from=${id}`}
                    onClick={(e) => {
                      // the next stage is made from this one, in this tab; the keys are shown once, so a set whose
                      // keys are neither kept nor copied warns once before the screen is left
                      if (!keepAll && !keysCopied && !leaveWarned) {
                        e.preventDefault();
                        setLeaveWarned(true);
                      }
                    }}
                  >
                    {set.flipNext}
                  </a>
                  {key !== null ? (
                    <>
                      <button
                        type="button"
                        className="pill"
                        aria-expanded={shown.has(id)}
                        onClick={() =>
                          setShown((was) => {
                            const next = new Set(was);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                      >
                        {shown.has(id) ? set.hideKey : set.showKey}
                      </button>
                      {shown.has(id) ? (
                        <code aria-label={fill(set.keyLabel, { title: titleOf(sketchId) })}>
                          {key}
                        </code>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="pill"
              onClick={() => {
                const lines = published.flatMap(([sketchId, state]) => {
                  const id = state.status === "published" ? state.id : "";
                  const key = keys.get(id) ?? keptKeys(sketchStorage())[id];
                  return key ? [`${titleOf(sketchId)}\t/p/${id}\t${key}`] : [];
                });
                navigator.clipboard.writeText(lines.join("\n")).then(
                  () => {
                    setKeysCopied(true);
                    setCopied(set.keysCopied);
                  },
                  () => setCopied(set.keysCopyFailed),
                );
              }}
            >
              {set.copyKeys}
            </button>
            <a className="pill" href="/flips">
              {copy.publish.done.flips}
            </a>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={keepAll}
              onChange={(e) => {
                setKeepAll(e.target.checked);
                for (const [, state] of published) {
                  if (state.status !== "published") continue;
                  if (e.target.checked) {
                    const key = keys.get(state.id);
                    if (key) keepKey(sketchStorage(), state.id, key);
                  } else forgetKey(sketchStorage(), state.id);
                }
                if (!e.target.checked) setCopied(set.forgotten);
              }}
            />
            <span>
              {set.keep} <span className="gloss">{set.keepGloss}</span>
            </span>
          </label>
          <p role="status" className="hint">
            {copied}
          </p>
          {leaveWarned ? (
            <p className="notice" role="alert">
              {set.leaveWarn}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
