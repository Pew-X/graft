"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { copy } from "../lib/copy.ts";
import { underlinePath } from "../lib/coach/marks.ts";

/** How long the last caption stays up before the narration is over and the hints may come. */
const LAST_STAYS_MS = 6500;

/**
 * One caption of the first play, in the marker hand with a hand-drawn underline. It is told which
 * moment of the roll the sound is at and says what is true of that moment; it does not time anything
 * itself, apart from letting the last caption be read before the narration is over. It sits in the
 * status slot, so it needs no room the roll has not already kept, and never lies on the record.
 */
export function Caption({
  text,
  moment,
  last,
  onSkip,
  onEnd,
}: {
  text: string;
  /** Changes with each moment, so the underline is drawn again. */
  moment: string;
  /** This is the caption the narration ends on. */
  last: boolean;
  onSkip: () => void;
  onEnd: () => void;
}) {
  useEffect(() => {
    if (!last) return undefined;
    const id = window.setTimeout(onEnd, LAST_STAYS_MS);
    return () => window.clearTimeout(id);
  }, [last, moment, onEnd]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  // the same moment always draws the same line; a different moment draws a different one
  const seed = useMemo(() => [...moment].reduce((n, c) => n * 31 + c.charCodeAt(0), 7), [moment]);
  // the underline is drawn at the words' own width, so its stroke is not stretched
  const words = useRef<HTMLParagraphElement>(null);
  const [width, setWidth] = useState(200);
  useLayoutEffect(() => {
    if (words.current) setWidth(Math.max(40, Math.round(words.current.offsetWidth)));
  }, [text, moment]);
  const line = useMemo(() => underlinePath(width, seed), [width, seed]);

  return (
    <div className="caption" data-testid="narration" data-moment={moment}>
      <p className="caption-text" role="status" aria-live="polite" key={moment} ref={words}>
        <span>{text}</span>
        <svg viewBox={`0 0 ${width} 12`} width={width} height="12" aria-hidden="true">
          <path d={line} pathLength={1} />
        </svg>
      </p>
      <button type="button" className="caption-skip" onClick={onSkip}>
        {copy.narration.skip}
      </button>
    </div>
  );
}
