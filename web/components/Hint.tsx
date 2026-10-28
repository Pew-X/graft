"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { arrowPath, edgeToward, placeCard, type Rect } from "../lib/coach/marks.ts";

/** How long a hint stays before it fades by itself. */
const STAYS_MS = 7000;

/**
 * A small hint, drawn on the real screen beside the thing it points at, with a short marker arrow. It
 * never catches a press (the whole thing ignores the pointer), never covers its target, never moves the
 * layout, and goes by itself. `find` measures the target now; the hint shows only while it is on screen.
 */
export function Hint({
  text,
  find,
  prefer,
  seed,
  onFaded,
}: {
  text: string;
  find: () => Rect | null;
  prefer: readonly ("above" | "below" | "left" | "right")[];
  seed: number;
  onFaded: () => void;
}) {
  const note = useRef<HTMLParagraphElement>(null);
  const [drawn, setDrawn] = useState<{ x: number; y: number; shaft: string; head: string } | null>(
    null,
  );
  const measure = useCallback((): void => {
    const target = find();
    const el = note.current;
    if (!target || !el) {
      setDrawn(null);
      return;
    }
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const view = { w: window.innerWidth, h: window.innerHeight };
    if (
      target.x < 0 ||
      target.y < 0 ||
      target.x + target.w > view.w ||
      target.y + target.h > view.h
    ) {
      setDrawn(null);
      return;
    }
    const spot = placeCard(target, size, view, 12, 44, prefer);
    const centre = { x: spot.x + size.w / 2, y: spot.y + size.h / 2 };
    const from = edgeToward(
      { x: spot.x, y: spot.y, w: size.w, h: size.h },
      {
        x: target.x + target.w / 2,
        y: target.y + target.h / 2,
      },
      4,
    );
    const to = edgeToward(target, centre, 8);
    const arrow = arrowPath(from, to, seed);
    setDrawn({ x: spot.x, y: spot.y, shaft: arrow.shaft, head: arrow.head });
  }, [find, prefer, seed]);

  useLayoutEffect(() => {
    // the first look is a frame away (the words have to be on the page to be measured), then it keeps
    // looking: the page under a hint moves for a moment as the roll slides to its stage
    const first = window.requestAnimationFrame(measure);
    const again = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(first);
      window.clearInterval(again);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // the clock starts when the hint is first seen, not when it is armed
  const shown = drawn !== null;
  useEffect(() => {
    if (!shown) return undefined;
    const id = window.setTimeout(onFaded, STAYS_MS);
    return () => window.clearTimeout(id);
  }, [shown, onFaded]);

  return (
    <div className="hint-layer" data-testid="hint" data-shown={shown} aria-hidden={!shown}>
      {drawn ? (
        <svg
          className="hint-arrow"
          width="100%"
          height="100%"
          viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
          aria-hidden="true"
        >
          <path d={drawn.shaft} pathLength={1} />
          <path d={drawn.head} pathLength={1} />
        </svg>
      ) : null}
      <p
        ref={note}
        className="hint-note"
        role="status"
        aria-live="polite"
        style={{
          left: drawn?.x ?? 0,
          top: drawn?.y ?? 0,
          visibility: shown ? "visible" : "hidden",
        }}
      >
        {text}
      </p>
    </div>
  );
}
