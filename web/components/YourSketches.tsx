"use client";

import { useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { intervalPhrase, secondsText } from "../lib/flips/describe.ts";
import { below, discard, rename, twinOf } from "../lib/sketch/book.ts";
import { type Sketch } from "../lib/sketch/sketch.ts";
import { cleanTitle, TITLE_LIMIT } from "../lib/sketch/title.ts";
import { announceSketchChange, sketchStorage, useSketchBook } from "./useSketchBook.ts";

function Row({
  sketch,
  isOpen,
  goingOn,
  twin,
  onOpen,
  onGone,
}: {
  sketch: Sketch;
  isOpen: boolean;
  /** How many sketches go on from this one. */
  goingOn: number;
  twin: Sketch | null;
  onOpen: (sketch: Sketch) => void;
  onGone: (message: string) => void;
}) {
  const c = copy.sketch;
  const [mode, setMode] = useState<"idle" | "rename" | "discard">("idle");
  const [title, setTitle] = useState(sketch.title);
  const [problem, setProblem] = useState("");
  return (
    <li
      className="your-sketch"
      data-open={isOpen}
      data-published={sketch.publishedAs !== undefined}
    >
      <p className="sketch-title">{sketch.title}</p>
      <p className="hint sketch-facts">
        {fill(c.facts, {
          interval: intervalPhrase(sketch.p, sketch.q),
          from: secondsText(sketch.cut.start),
          to: secondsText(sketch.cut.end),
        })}
      </p>
      {twin ? <p className="hint">{fill(c.twin, { title: twin.title })}</p> : null}
      {sketch.publishedAs !== undefined ? (
        <p className="hint">
          {c.published}{" "}
          <a className="link" href={`/p/${sketch.publishedAs}`}>
            {c.openPublished}
          </a>
        </p>
      ) : null}
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
              if (done.ok)
                onGone(
                  done.removed.length > 1
                    ? fill(c.discardedOthers, { n: done.removed.length - 1 })
                    : c.discarded,
                );
              else setProblem(c.failed.storage);
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
      <p role="status" className="hint">
        {problem}
      </p>
    </li>
  );
}

/**
 * The sketches this browser keeps, newest first, with the ways to open, rename and discard one. It shows
 * nothing at all when there are none (the picker and the editor each say what a sketch is in their own
 * words). Discarding asks once, and says how many sketches go on from the one discarded.
 */
export function YourSketches({
  openedId,
  onOpen,
  children,
}: {
  openedId: string | null;
  onOpen: (sketch: Sketch) => void;
  children?: React.ReactNode;
}) {
  const book = useSketchBook();
  const [message, setMessage] = useState("");
  const c = copy.sketch;
  if (book.sketches.length === 0 && message === "") return null;
  return (
    <section aria-labelledby="your-sketches" data-testid="your-sketches" className="your-sketches">
      <h3 id="your-sketches" className="kicker">
        {c.heading}
      </h3>
      <p className="hint">{c.intro}</p>
      <ul className="sketch-list">
        {[...book.sketches].reverse().map((s) => (
          <Row
            key={s.id}
            sketch={s}
            isOpen={openedId === s.id}
            goingOn={below(book, s.id).length}
            twin={twinOf(book, s)}
            onOpen={onOpen}
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
