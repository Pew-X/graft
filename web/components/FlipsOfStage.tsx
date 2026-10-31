"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { describeFlip } from "../lib/flips/describe.ts";
import { type FlipItem, readFlips } from "../lib/flips/read.ts";
import { parseBankHash, type BankLink } from "../lib/perform/bank-link.ts";
import { FlipsBank, type FlipsAudio } from "./FlipsBank.tsx";
import { Trace } from "./Trace.tsx";

/** A service that did not answer is often one that was asleep: ask again by itself, a few times. */
const ASK_AGAIN_MS = 6_000;
const ASK_AGAIN_TIMES = 20;

type First =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; total: number; flips: FlipItem[]; next: string | null };

/**
 * "flips of this stage (N)": the published flips whose parent is this stage, newest first. It shows
 * nothing at all until it knows there is at least one (no empty heading); a service that is asleep or
 * offline is said once and asked again by itself; a failed second page keeps the first on the screen.
 * Titles and makers are shown as typed; each description is built only from computed facts.
 */
export function FlipsOfStage({
  id,
  apiUrl,
  audio,
}: {
  id: string;
  apiUrl: string;
  /** What the roll lends a bank of these flips; without it the list has no pads. */
  audio?: FlipsAudio | undefined;
}) {
  const uid = useId();
  const [first, setFirst] = useState<First>({ status: "loading" });
  const [again, setAgain] = useState(0);
  const [open, setOpen] = useState(false);
  const [padsOpen, setPadsOpen] = useState(false);
  // a link that carries a bank of this stage's flips: offered, never played by itself
  const [arrived, setArrived] = useState<BankLink | null>(null);
  useEffect(() => {
    if (!audio) return undefined;
    const read = (): void => {
      const found = parseBankHash(window.location.hash, audio.stageIds);
      if (found && found.stage === id) {
        setArrived(found);
        setOpen(true);
        setPadsOpen(true);
      }
    };
    queueMicrotask(read);
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [audio, id]);
  // `next` is undefined until a second page has been read: the first page's own cursor stands until then
  const [more, setMore] = useState<{
    flips: FlipItem[];
    next: string | null | undefined;
    failed: boolean;
    busy: boolean;
  }>({ flips: [], next: undefined, failed: false, busy: false });
  const [now] = useState(() => Date.now());
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    readFlips(apiUrl, id, null, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setFirst(
          page === null
            ? { status: "ready", total: 0, flips: [], next: null }
            : { status: "ready", total: page.total, flips: page.flips, next: page.next ?? null },
        );
      },
      () => {
        if (!controller.signal.aborted) setFirst({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [apiUrl, id, again]);

  const failed = first.status === "failed";
  useEffect(() => {
    if (!failed || again >= ASK_AGAIN_TIMES) return undefined;
    const timer = window.setTimeout(() => setAgain((n) => n + 1), ASK_AGAIN_MS);
    return () => window.clearTimeout(timer);
  }, [failed, again]);

  const showMore = useCallback(
    async (cursor: string) => {
      setMore((m) => ({ ...m, busy: true, failed: false }));
      try {
        const page = await readFlips(apiUrl, id, cursor);
        setMore((m) => ({
          flips: [...m.flips, ...(page?.flips ?? [])],
          next: page?.next ?? null,
          failed: false,
          busy: false,
        }));
      } catch {
        setMore((m) => ({ ...m, failed: true, busy: false }));
      }
    },
    [apiUrl, id],
  );

  const c = copy.stageFlips;
  if (first.status === "loading") return null;
  if (first.status === "failed")
    return (
      <p className="flips-of-note" role="status">
        {c.failed}{" "}
        <button type="button" className="quiet-link" onClick={() => setAgain((n) => n + 1)}>
          {c.tryAgain}
        </button>
      </p>
    );
  if (first.total === 0 || first.flips.length === 0)
    return <p className="flips-of-note">{c.none}</p>;
  const shown = [...first.flips, ...more.flips];
  const next = more.next === undefined ? first.next : more.next;
  const listId = `${uid}-list`;
  return (
    <div className="flips-of" data-testid="flips-of">
      <button
        type="button"
        className="flips-of-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        {fill(c.line, { n: first.total })}
      </button>
      <div id={listId} hidden={!open}>
        <ul ref={listRef} className="flips-of-list" aria-label={c.label}>
          {shown.map((flip) => (
            <li key={flip.id} className="flips-of-item">
              <div className="flips-of-trace" aria-hidden="true">
                <Trace id={flip.id} label="" decorative />
              </div>
              <div className="flips-of-text">
                <a className="flips-of-title" href={`/p/${flip.id}`}>
                  {flip.title}
                </a>
                <span className="flips-of-by">{fill(c.by, { author: flip.author })}</span>
                <span className="flips-of-facts">
                  {describeFlip(
                    {
                      speed: flip.speed,
                      frames: flip.frames,
                      createdAtMs: flip.created_at_ms,
                    },
                    now,
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
        {more.failed ? (
          <p className="flips-of-note" role="status">
            {c.moreFailed}
          </p>
        ) : null}
        {next !== null ? (
          <button
            type="button"
            className="quiet-link"
            disabled={more.busy}
            onClick={() => void showMore(next)}
          >
            {more.failed ? c.tryAgain : c.more}
          </button>
        ) : null}
        <p className="hint">{c.newest}</p>
        {audio ? (
          padsOpen ? (
            <FlipsBank
              stage={id}
              apiUrl={apiUrl}
              flips={first.flips}
              total={first.total}
              audio={audio}
              arrived={arrived}
              onClose={() => setPadsOpen(false)}
            />
          ) : (
            <button
              type="button"
              className="pill"
              onClick={() => {
                setArrived(null);
                setPadsOpen(true);
              }}
            >
              {copy.stageFlips.bank.open}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
