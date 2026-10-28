"use client";

import { useEffect } from "react";
import { copy } from "../lib/copy.ts";
import type { MakePhase } from "../lib/coach/make.ts";

/** How long the last line stays before it goes by itself. The others wait for their thing to be done. */
const LAST_STAYS_MS = 10_000;

/**
 * The make flow's hints: one line at a time in a slot that keeps its height, so nothing below it moves
 * when the line changes or goes. It catches no press except its own skip, and each line goes when the
 * visitor does what it says. `line` is null where no line fits the screen (the slot is still kept).
 */
export function MakeGuide({
  line,
  onSkip,
  onFaded,
}: {
  line: Exclude<MakePhase, "done"> | null;
  onSkip: () => void;
  onFaded: () => void;
}) {
  useEffect(() => {
    if (line !== "share") return;
    const t = setTimeout(onFaded, LAST_STAYS_MS);
    return () => clearTimeout(t);
  }, [line, onFaded]);

  return (
    <div className="make-guide" data-testid="make-guide" data-line={line ?? "none"}>
      {line ? (
        <>
          <p
            key={line}
            className="make-guide-text"
            role="status"
            aria-label={copy.make.guide.label}
          >
            {copy.make.guide[line]}
          </p>
          <button type="button" className="make-guide-skip" onClick={onSkip}>
            {copy.make.guide.skip}
          </button>
        </>
      ) : null}
    </div>
  );
}
