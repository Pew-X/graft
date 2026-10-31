"use client";

import { useEffect, useMemo, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { type Cut, refusal } from "../lib/make/cut.ts";
import { outline, peaks } from "../lib/make/peaks.ts";
import type { Previewer } from "../lib/make/preview.ts";
import { MAX_FRAMES, checkTrim } from "../lib/own/source.ts";
import {
  POSITION_STEP,
  VIEW_FRAMES,
  clampPosition,
  clock,
  lastPosition,
  needsWindow,
  startingCut,
  windowAt,
} from "../lib/own/trim.ts";
import { CutEditor } from "./CutEditor.tsx";

const OVERVIEW_BUCKETS = 600;

/**
 * A recording longer than a source may be: pick the part to keep, up to 15 seconds, and hear it before using
 * it. A recording of a minute or less is shown whole. A longer one (up to thirty minutes) is shown through a
 * window of a minute that is moved along it with a labelled control, over a small picture of the whole, so a
 * part can be found by ear and placed with the same brackets as a cut.
 */
export function TrimStep({
  samples,
  previewer,
  onUse,
  onCancel,
}: {
  samples: Int16Array;
  previewer: Previewer;
  onUse: (part: Int16Array) => void;
  onCancel: () => void;
}) {
  const total = samples.length;
  const long = needsWindow(total);
  const [position, setPosition] = useState(0);
  const win = windowAt(total, position);
  const view = useMemo(() => samples.subarray(win.start, win.end), [samples, win.start, win.end]);
  const [cut, setCut] = useState<Cut>(() => startingCut(windowAt(total, 0).end));
  const [hearing, setHearing] = useState(false);
  const overview = useMemo(
    () => (long ? outline(peaks(samples, OVERVIEW_BUCKETS)) : ""),
    [samples, long],
  );
  useEffect(() => () => previewer.stop(), [previewer]);

  const part: Cut = { start: win.start + cut.start, end: win.start + cut.end };
  const problem = checkTrim(part, total);
  const why = problem
    ? problem.kind === "cutLong"
      ? fill(copy.own.trimTooLong, { max: MAX_FRAMES })
      : refusal(problem)
    : "";

  const move = (next: number) => {
    previewer.stop();
    setHearing(false);
    const at = clampPosition(total, next);
    setPosition(at);
    const w = windowAt(total, at);
    setCut(startingCut(w.end - w.start));
  };
  const hear = async () => {
    if (hearing) {
      previewer.stop();
      setHearing(false);
      return;
    }
    if (problem) return;
    setHearing(true);
    try {
      await previewer.unlock();
      await previewer.playOnce(samples.slice(part.start, part.end));
    } finally {
      setHearing(false);
    }
  };

  return (
    <section className="panel trim" aria-labelledby="trim-heading">
      <h3 id="trim-heading" className="kicker">
        {copy.own.trimHeading} <span className="gloss">{copy.own.trimGloss}</span>
      </h3>
      {long ? (
        <div className="trim-where" data-testid="trim-where">
          <p className="hint">{fill(copy.own.trimLong, { total: clock(total) })}</p>
          <svg
            className="trim-overview"
            viewBox={`0 0 ${OVERVIEW_BUCKETS} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className="wave-rest" d={overview} />
            <rect
              className="trim-window"
              x={(win.start / total) * OVERVIEW_BUCKETS}
              y="0"
              width={(VIEW_FRAMES / total) * OVERVIEW_BUCKETS}
              height="100"
            />
          </svg>
          <label>
            <span className="visually-hidden">{copy.own.trimWhere}</span>
            <input
              type="range"
              min={0}
              max={lastPosition(total)}
              step={POSITION_STEP}
              value={win.start}
              aria-valuetext={fill(copy.own.trimWhereValue, {
                at: clock(win.start),
                total: clock(total),
              })}
              onChange={(e) => move(Number(e.target.value))}
            />
          </label>
          <p className="readout" data-testid="trim-at">
            {fill(copy.own.trimWhereValue, { at: clock(win.start), total: clock(total) })}
          </p>
        </div>
      ) : null}
      <CutEditor samples={view} cut={cut} onChange={setCut} onTouch={() => undefined} />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={problem !== null}
          aria-describedby="trim-why"
          onClick={() => {
            previewer.stop();
            onUse(samples.slice(part.start, part.end));
          }}
        >
          {copy.own.trimUse}
        </button>
        <button
          type="button"
          className="pill"
          disabled={problem !== null}
          onClick={() => void hear()}
        >
          {hearing ? copy.own.trimStopHear : copy.own.trimHear}
        </button>
        <button
          type="button"
          className="pill"
          onClick={() => {
            previewer.stop();
            onCancel();
          }}
        >
          {copy.make.pick.change}
        </button>
        <p id="trim-why" className="refusal" role="status">
          {why}
        </p>
      </div>
    </section>
  );
}
