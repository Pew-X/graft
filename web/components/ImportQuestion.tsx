"use client";

import { useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { MOST_SKETCHES } from "../lib/sketch/sketch.ts";
import { type Refusal, importEntries, read } from "../lib/sketch/move.ts";
import { announceSketchChange, sketchStorage } from "./useSketchBook.ts";

const SHOWN_TITLES = 12;

/**
 * Sketches that came in a link or a file are a question, never an action: what they carry is listed, and
 * nothing is added until the visitor says yes. A text that cannot be read in full is refused whole, with the
 * reason in words. Whatever the answer, `onDone` is called so the address can be cleaned.
 */
export function ImportQuestion({
  text,
  mostBytes,
  onDone,
}: {
  text: string;
  mostBytes?: number;
  onDone: () => void;
}) {
  const m = copy.sketch.move;
  const parsed = read(text, mostBytes);
  const [result, setResult] = useState<string | null>(null);
  if (result !== null || !parsed.ok) {
    const refused = !parsed.ok
      ? fill(m.refused[parsed.why as Refusal], { max: MOST_SKETCHES })
      : "";
    return (
      <div className="sketch-arrival" role="status" data-testid="import-result">
        <p>{result ?? refused}</p>
        <button type="button" className="pill" onClick={onDone}>
          {copy.keys.close}
        </button>
      </div>
    );
  }
  const n = parsed.entries.length;
  return (
    <div
      className="sketch-arrival"
      role="group"
      aria-label={m.summary}
      data-testid="import-question"
    >
      <p>{fill(m.question, { what: n === 1 ? m.one : fill(m.many, { n }) })}</p>
      <ul>
        {parsed.entries.slice(0, SHOWN_TITLES).map((e, i) => (
          <li key={i}>{e.title}</li>
        ))}
      </ul>
      {n > SHOWN_TITLES ? (
        <p className="hint">{fill(m.moreTitles, { n: n - SHOWN_TITLES })}</p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="pill"
          onClick={() => {
            const done = importEntries(sketchStorage(), parsed.entries);
            announceSketchChange();
            if (!done.ok) {
              setResult(done.why === "newer" ? m.newer : m.storageFailed);
              return;
            }
            const { plan } = done;
            const parts = [fill(m.added, { n: plan.added.length })];
            if (plan.alreadyHere > 0) parts.push(fill(m.already, { n: plan.alreadyHere }));
            if (plan.leftOut.length > 0)
              parts.push(fill(m.leftOut, { max: MOST_SKETCHES, titles: plan.leftOut.join(", ") }));
            setResult(parts.join(" "));
          }}
        >
          {m.yes}
        </button>
        <button type="button" className="pill" onClick={onDone}>
          {m.no}
        </button>
      </div>
    </div>
  );
}
