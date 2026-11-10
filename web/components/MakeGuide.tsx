"use client";

import { useEffect } from "react";
import { copy } from "../lib/copy.ts";
import type { MakePhase } from "../lib/coach/make.ts";

/** How long the last line stays before it goes by itself. The others wait for their thing to be done. */
const LAST_STAYS_MS = 10_000;

/** The control each line names, so "show me" can bring it into view. A line with no entry has no button. */
const TARGETS: Partial<Record<Exclude<MakePhase, "done">, string>> = {
  hear: '[data-guide="hear"]',
  keep: '[data-guide="keep"]',
  pads: '[data-testid="sketch-bank"]',
  publish: '[data-testid="set-publisher"]',
};

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
    if (line !== "next") return;
    const t = setTimeout(onFaded, LAST_STAYS_MS);
    return () => clearTimeout(t);
  }, [line, onFaded]);

  /** Bring the control a line names into view and focus it: a press, never a scroll the visitor did not ask for. */
  const show = () => {
    const target = line ? TARGETS[line] : undefined;
    const el = target ? document.querySelector<HTMLElement>(target) : null;
    if (!el) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    const focusable = el.matches("button, a, input")
      ? el
      : el.querySelector<HTMLElement>("button, a, input");
    focusable?.focus({ preventScroll: true });
  };

  return (
    <div className="make-guide" data-testid="make-guide" data-line={line ?? "none"}>
      {line ? (
        <>
          <div className="make-guide-copy">
            <p
              key={line}
              className="make-guide-text"
              role="status"
              aria-label={copy.make.guide.label}
            >
              {copy.make.guide[line]}
            </p>
            {/* what the keyboard does to a bracket, under the line that says to move one: same slot, no new height */}
            {line === "change" ? (
              <p className="make-guide-keys">{copy.make.guide.changeKeys}</p>
            ) : null}
          </div>
          {line && TARGETS[line] ? (
            <button type="button" className="make-guide-skip" onClick={show}>
              {copy.make.guide.show}
            </button>
          ) : null}
          <button type="button" className="make-guide-skip" onClick={onSkip}>
            {copy.make.guide.skip}
          </button>
        </>
      ) : null}
    </div>
  );
}
