"use client";

import { useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { type Cut, refusal } from "../lib/make/cut.ts";
import { MAX_FRAMES, checkTrim } from "../lib/own/source.ts";
import { CutEditor } from "./CutEditor.tsx";

/** A recording longer than a source may be: pick the part to keep, up to 15 seconds. */
export function TrimStep({
  samples,
  onUse,
  onCancel,
}: {
  samples: Int16Array;
  onUse: (part: Int16Array) => void;
  onCancel: () => void;
}) {
  const [cut, setCut] = useState<Cut>({ start: 0, end: Math.min(samples.length, MAX_FRAMES) });
  const problem = checkTrim(cut, samples.length);
  const why = problem
    ? problem.kind === "cutLong"
      ? fill(copy.own.trimTooLong, { max: MAX_FRAMES })
      : refusal(problem)
    : "";
  return (
    <section className="panel" aria-labelledby="trim-heading">
      <h3 id="trim-heading" className="kicker">
        {copy.own.trimHeading} <span className="gloss">{copy.own.trimGloss}</span>
      </h3>
      <CutEditor samples={samples} cut={cut} onChange={setCut} onTouch={() => undefined} />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={problem !== null}
          aria-describedby="trim-why"
          onClick={() => onUse(samples.slice(cut.start, cut.end))}
        >
          {copy.own.trimUse}
        </button>
        <button type="button" className="pill" onClick={onCancel}>
          {copy.make.pick.change}
        </button>
        <p id="trim-why" className="refusal" role="status">
          {why}
        </p>
      </div>
    </section>
  );
}
