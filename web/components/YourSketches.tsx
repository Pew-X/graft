"use client";

import { useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { intervalPhrase, secondsText } from "../lib/flips/describe.ts";
import { outputFrames } from "../lib/make/cut.ts";
import { type Book, below, discard, rename, twinOf } from "../lib/sketch/book.ts";
import { remaining } from "../lib/sketch/depth.ts";
import { pathOf } from "../lib/sketch/path.ts";
import { type Sketch } from "../lib/sketch/sketch.ts";
import { cleanTitle, TITLE_LIMIT } from "../lib/sketch/title.ts";
import { Trace } from "./Trace.tsx";
import { announceSketchChange, sketchStorage, useSketchBook } from "./useSketchBook.ts";
import { useStageDepth } from "./useStageDepth.ts";

/** Two sketches marked to be heard against each other, and what plays them. Kept by the make page, which owns the one audio context. */
export interface CompareApi {
  a: string | null;
  b: string | null;
  /** Which one "play one" plays on the next press. */
  next: "a" | "b";
  playing: boolean;
  message: string;
  mark: (side: "a" | "b", id: string) => void;
  playBoth: () => void;
  playOne: () => void;
  stop: () => void;
  clear: () => void;
}

/** Which sketches are chosen for "publish these". */
export interface ChooseApi {
  has: (id: string) => boolean;
  toggle: (id: string) => void;
}

/** What a row can do with the sketch bank: whether this sketch is on it, and putting it on or taking it off. */
export interface BankApi {
  has: (id: string) => boolean;
  /** Returns words when it could not be done. */
  add: (id: string) => string;
  remove: (id: string) => void;
}

interface Where {
  apiUrl: string;
  /** How many stages a shipped stage's chain has, or null for one the service must be asked about. */
  shippedDepth: (id: string) => number | null;
}

function Row({
  sketch,
  book,
  isOpen,
  goingOn,
  twin,
  where,
  compare,
  bank,
  choose,
  onOpen,
  onGoOn,
  onGone,
}: {
  sketch: Sketch;
  book: Book;
  isOpen: boolean;
  /** How many sketches go on from this one. */
  goingOn: number;
  twin: Sketch | null;
  where: Where;
  compare: CompareApi | undefined;
  bank: BankApi | undefined;
  choose: ChooseApi | undefined;
  onOpen: (sketch: Sketch) => void;
  onGoOn: (sketch: Sketch) => void;
  onGone: (message: string) => void;
}) {
  const c = copy.sketch;
  const [mode, setMode] = useState<"idle" | "rename" | "discard">("idle");
  const [title, setTitle] = useState(sketch.title);
  const [problem, setProblem] = useState("");
  const path = pathOf(book, sketch.id);
  const rootId = path.ok ? path.root : null;
  const depth = useStageDepth(
    where.apiUrl,
    rootId,
    rootId === null ? null : where.shippedDepth(rootId),
  );
  // the stage this sketch's path starts on, and the stages above the sketch that would go on from it
  const above = path.ok ? path.sketches.length : 0;
  const room = depth.state === "known" ? remaining(depth.stages, above) : null;
  const parentSketch =
    sketch.parent.kind === "sketch"
      ? book.sketches.find((s) => s.id === (sketch.parent as { id: string }).id)
      : null;
  const fromLine = parentSketch
    ? fill(c.from.sketch, { title: parentSketch.title })
    : depth.state === "known" && path.ok
      ? fill(c.from.stage, { n: depth.stages })
      : c.from.stageUnknown;
  const out = outputFrames(sketch.cut.end - sketch.cut.start, sketch.p, sketch.q);
  const marked = compare?.a === sketch.id ? "a" : compare?.b === sketch.id ? "b" : null;
  return (
    <li
      className="your-sketch"
      data-open={isOpen}
      data-published={sketch.publishedAs !== undefined}
      data-marked={marked ?? undefined}
    >
      <div className="sketch-head">
        <div className="sketch-trace" aria-hidden="true">
          <Trace id={sketch.id} label="" decorative />
        </div>
        <div className="sketch-text">
          <p className="sketch-title">{sketch.title}</p>
          <p className="hint sketch-from">{fromLine}</p>
          <p className="hint sketch-facts">
            {fill("{interval}, {out} s", {
              interval: intervalPhrase(sketch.p, sketch.q),
              out: secondsText(out),
            })}
          </p>
          <p className="hint sketch-cut">
            {fill(c.cutLine, {
              from: secondsText(sketch.cut.start),
              to: secondsText(sketch.cut.end),
            })}
          </p>
        </div>
      </div>
      {twin ? <p className="hint">{fill(c.twin, { title: twin.title })}</p> : null}
      {sketch.publishedAs !== undefined ? (
        <p className="hint">
          {c.published}{" "}
          <a className="link" href={`/p/${sketch.publishedAs}`}>
            {c.openPublished}
          </a>
        </p>
      ) : null}
      {choose && sketch.publishedAs === undefined ? (
        <label className="check sketch-choose">
          <input
            type="checkbox"
            checked={choose.has(sketch.id)}
            onChange={() => choose.toggle(sketch.id)}
          />
          <span>{c.set.choose}</span>
        </label>
      ) : null}
      <p className="hint sketch-room" role="status">
        {depth.state === "checking"
          ? c.budget.checking
          : depth.state === "failed"
            ? c.budget.failed
            : room === 0
              ? c.budget.none
              : room === 1
                ? c.budget.roomOne
                : fill(c.budget.room, { n: room ?? 0 })}
      </p>
      {mode === "rename" ? (
        <form
          className="sketch-rename"
          onSubmit={(e) => {
            e.preventDefault();
            const cleaned = cleanTitle(title);
            if (!cleaned.ok) {
              setProblem(
                fill(c.titleWhy[cleaned.rule], { limit: TITLE_LIMIT, detail: cleaned.detail }),
              );
              return;
            }
            const done = rename(sketchStorage(), sketch.id, cleaned.value);
            announceSketchChange();
            if (done.ok) setMode("idle");
            else setProblem(c.failed.invalid);
          }}
        >
          <label>
            <span className="visually-hidden">{c.renameLabel}</span>
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
            {c.renameSave}
          </button>
          <button type="button" className="pill" onClick={() => setMode("idle")}>
            {c.discardNo}
          </button>
        </form>
      ) : mode === "discard" ? (
        <div className="sketch-ask" role="group" aria-label={c.discardAsk}>
          <p className="hint">
            {goingOn > 0 ? fill(c.discardAskMany, { n: goingOn }) : c.discardAsk}
          </p>
          <button
            type="button"
            className="pill"
            onClick={() => {
              const done = discard(sketchStorage(), sketch.id);
              announceSketchChange();
              if (done.ok) {
                compare?.clear();
                onGone(
                  done.removed.length > 1
                    ? fill(c.discardedOthers, { n: done.removed.length - 1 })
                    : c.discarded,
                );
              } else setProblem(c.failed.storage);
              setMode("idle");
            }}
          >
            {c.discardYes}
          </button>
          <button type="button" className="pill" onClick={() => setMode("idle")}>
            {c.discardNo}
          </button>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="pill" onClick={() => onOpen(sketch)}>
            {c.open}
          </button>
          <button
            type="button"
            className="pill"
            disabled={room === null || room === 0 || !path.ok}
            aria-describedby={room === 0 ? `why-${sketch.id}` : undefined}
            onClick={() => onGoOn(sketch)}
          >
            {c.goOn}
          </button>
          {compare ? (
            <span className="sketch-marks" role="group" aria-label={c.compare.group}>
              {(["a", "b"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  className="pill mark"
                  aria-pressed={marked === side}
                  aria-label={fill(c.compare.marked, { side: side.toUpperCase() })}
                  onClick={() => compare.mark(side, sketch.id)}
                >
                  {side.toUpperCase()}
                </button>
              ))}
            </span>
          ) : null}
          {bank ? (
            <button
              type="button"
              className="pill"
              aria-pressed={bank.has(sketch.id)}
              onClick={() => {
                if (bank.has(sketch.id)) bank.remove(sketch.id);
                else setProblem(bank.add(sketch.id));
              }}
            >
              {bank.has(sketch.id) ? c.bank.remove : c.bank.add}
            </button>
          ) : null}
          {sketch.publishedAs === undefined ? (
            <button type="button" className="pill" onClick={() => setMode("rename")}>
              {c.rename}
            </button>
          ) : null}
          <button type="button" className="pill" onClick={() => setMode("discard")}>
            {c.discard}
          </button>
        </div>
      )}
      {room === 0 ? (
        <p id={`why-${sketch.id}`} className="hint">
          {fill(c.goOnWhy, { why: c.budget.none })}
        </p>
      ) : null}
      <p role="status" className="hint">
        {problem}
      </p>
    </li>
  );
}

/**
 * The sketches this browser keeps, newest first, as a strip: each says where it came from, what it does
 * (computed facts only) and how many more stages fit after it, and can be opened, gone on from, marked for
 * a comparison, renamed or discarded. It shows nothing at all when there are none. Discarding asks once, and
 * says how many sketches go on from the one discarded.
 */
export function YourSketches({
  openedId,
  onOpen,
  onGoOn,
  where,
  compare,
  bank,
  choose,
  teach = false,
  children,
}: {
  openedId: string | null;
  onOpen: (sketch: Sketch) => void;
  onGoOn: (sketch: Sketch) => void;
  where: Where;
  compare?: CompareApi;
  bank?: BankApi | undefined;
  choose?: ChooseApi | undefined;
  /** Say what a sketch is even when there are none yet (the editor is up and the maker may keep one). */
  teach?: boolean;
  children?: React.ReactNode;
}) {
  const book = useSketchBook();
  const [message, setMessage] = useState("");
  const c = copy.sketch;
  // with one sketch there is nothing to compare, no second pad and no set: those arrive with the second
  const many = book.sketches.length >= 2;
  if (book.sketches.length === 0 && message === "") {
    return teach ? (
      <section className="your-sketches" data-testid="no-sketches">
        <h3 className="kicker">{c.heading}</h3>
        <p className="hint">{c.empty}</p>
        <p className="hint">{c.where}</p>
      </section>
    ) : null;
  }
  return (
    <section aria-labelledby="your-sketches" data-testid="your-sketches" className="your-sketches">
      <h3 id="your-sketches" className="kicker">
        {c.heading}
      </h3>
      <p className="hint">{c.intro}</p>
      {compare && (compare.a !== null || compare.b !== null) ? (
        <div className="compare" role="group" aria-label={c.compare.group} data-testid="compare">
          <div className="actions">
            <button
              type="button"
              className="pill"
              disabled={compare.a === null || compare.b === null}
              onClick={compare.playBoth}
            >
              {fill(c.compare.playBoth, { first: "A", second: "B" })}
            </button>
            <button
              type="button"
              className="pill"
              disabled={compare.a === null || compare.b === null}
              onClick={compare.playOne}
            >
              {fill(c.compare.playOne, { side: compare.next.toUpperCase() })}
            </button>
            <button
              type="button"
              className="pill"
              disabled={!compare.playing}
              onClick={compare.stop}
            >
              {c.compare.stop}
            </button>
            <button type="button" className="pill" onClick={compare.clear}>
              {fill(c.compare.reset, { first: "A", second: "B" })}
            </button>
          </div>
          <p role="status" className="hint">
            {compare.message}
          </p>
        </div>
      ) : null}
      <ul className="sketch-list">
        {[...book.sketches].reverse().map((s) => (
          <Row
            key={s.id}
            sketch={s}
            book={book}
            isOpen={openedId === s.id}
            goingOn={below(book, s.id).length}
            twin={twinOf(book, s)}
            where={where}
            compare={many ? compare : undefined}
            bank={many ? bank : undefined}
            choose={many ? choose : undefined}
            onOpen={onOpen}
            onGoOn={onGoOn}
            onGone={setMessage}
          />
        ))}
      </ul>
      <p className="hint">{c.where}</p>
      {children}
      <p role="status" className="hint">
        {message}
      </p>
    </section>
  );
}
