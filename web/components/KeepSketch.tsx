"use client";

import { useId, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import type { FlipValue } from "../lib/make/editing.ts";
import { discard, keep, oldestUnused, readBook } from "../lib/sketch/book.ts";
import { defaultTitle } from "../lib/sketch/names.ts";
import { cleanTitle, TITLE_LIMIT } from "../lib/sketch/title.ts";
import { MOST_SKETCHES, type Parent, type Sketch } from "../lib/sketch/sketch.ts";
import { announceSketchChange, sketchStorage } from "./useSketchBook.ts";

/**
 * "keep as sketch": the try on the screen becomes a private sketch (a parent, a cut, a speed and a title)
 * in this browser. Nothing is sent anywhere. A keep that cannot be made says why and changes nothing: the
 * editor is as it was left.
 */
export function KeepSketch({
  parent,
  value,
  enabled,
  wholeFrames,
  label,
  onKept,
}: {
  /** What the sketch starts from; null while there is nothing published to start from (an own sound not yet published). */
  parent: Parent | null;
  value: FlipValue;
  /** The try on the screen can be rendered and is within the limits. */
  enabled: boolean;
  /** How long the sound being cut is, in frames: the default name mentions the cut unless it is all of it. */
  wholeFrames: number;
  /** The button's words: "keep as sketch", or "keep as another try" while a sketch is open. */
  label?: string;
  onKept?: (sketch: Sketch) => void;
}) {
  const uid = useId();
  const c = copy.sketch;
  const [title, setTitle] = useState("");
  const [said, setSaid] = useState("");
  const [offer, setOffer] = useState<Sketch | null>(null);

  const press = (): void => {
    if (parent === null) return;
    setOffer(null);
    const book = readBook(sketchStorage());
    let adjusted = false;
    let name: string;
    if (title.trim() === "") {
      name = defaultTitle({
        p: value.p,
        q: value.q,
        cut: value.cut,
        wholeFrames,
        taken: book.sketches
          .filter((s) => s.parent.kind === parent.kind && s.parent.id === parent.id)
          .map((s) => s.title),
      });
    } else {
      const cleaned = cleanTitle(title);
      if (!cleaned.ok) {
        setSaid(fill(c.titleWhy[cleaned.rule], { limit: TITLE_LIMIT, detail: cleaned.detail }));
        return;
      }
      name = cleaned.value;
      adjusted = cleaned.adjusted;
    }
    const made = keep(sketchStorage(), {
      parent,
      cut: value.cut,
      p: value.p,
      q: value.q,
      title: name,
    });
    announceSketchChange();
    if (made.ok) {
      setSaid(fill(adjusted ? c.keptAdjusted : c.kept, { title: made.sketch.title }));
      setTitle("");
      onKept?.(made.sketch);
      return;
    }
    if (made.why === "limit") {
      setSaid(fill(c.failed.limit, { max: MOST_SKETCHES }));
      setOffer(oldestUnused(readBook(sketchStorage())));
      return;
    }
    setSaid(c.failed[made.why]);
  };

  return (
    <div className="keep-sketch">
      <div className="field">
        <label htmlFor={`${uid}-title`}>
          {c.titleLabel} <span className="gloss">{c.titleGloss}</span>
        </label>
        <input
          id={`${uid}-title`}
          type="text"
          value={title}
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="pill"
          disabled={!enabled || parent === null}
          aria-describedby={`${uid}-said`}
          data-guide="keep"
          onClick={press}
        >
          {label ?? c.keep}
        </button>
      </div>
      <p id={`${uid}-said`} role="status" className="hint">
        {parent === null ? c.needSource : said}
      </p>
      {offer ? (
        <div className="sketch-ask" role="group">
          <p className="hint">{fill(c.offerDiscard, { title: offer.title })}</p>
          <button
            type="button"
            className="pill"
            onClick={() => {
              discard(sketchStorage(), offer.id);
              announceSketchChange();
              setOffer(null);
              setSaid("");
            }}
          >
            {c.discardYes}
          </button>
          <button type="button" className="pill" onClick={() => setOffer(null)}>
            {c.discardNo}
          </button>
        </div>
      ) : null}
      <p className="hint">{c.noAutosave}</p>
    </div>
  );
}
