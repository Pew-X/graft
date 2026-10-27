"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { copy, fill } from "../lib/copy.ts";
import {
  arrowPath,
  edgeToward,
  loopPath,
  placeCard,
  type Point,
  type Rect,
  type Side,
} from "../lib/coach/marks.ts";
import { markCoachSeen } from "../lib/coach/seen.ts";
import { layout, needleAt } from "../lib/record/disc.ts";

export type CoachStep = "play" | "needle" | "make";

const CARD_W = 330;

/**
 * Where each note likes to sit, so that it lands on empty space and not on the thing it explains: the
 * play note above the button; the needle note beside the needle (the dark middle of the screen) or, on
 * a phone, above it; the make note beside the button (the empty side of the stage), or below it.
 */
const PREFER: Record<CoachStep, readonly Side[]> = {
  play: ["above", "left", "below"],
  needle: ["left", "above", "below"],
  make: ["right", "below", "above"],
};

function boxOf(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width < 1 || r.height < 1 ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
}

/**
 * What each note points at, measured on the real page, so it follows the screen it is on: the thing to
 * circle, and the area the note must stay clear of (the same, except that on a wide screen the make
 * note keeps off the whole stage, so it lands in the empty space beside it).
 */
function targetFor(
  step: CoachStep,
  stages: number,
  hero: number,
): { target: Rect; clear: Rect } | null {
  const same = (r: Rect | null): { target: Rect; clear: Rect } | null =>
    r ? { target: r, clear: r } : null;
  if (step === "play") return same(boxOf(".controls .primary"));
  if (step === "needle") {
    const l = layout(window.innerWidth, window.innerHeight, Math.max(1, stages));
    const tip = needleAt(l, Math.min(Math.max(0, hero), Math.max(0, stages - 1)), 0);
    return same({ x: tip.x - 36, y: tip.y - 36, w: 72, h: 72 });
  }
  // the stage's own button when it is on screen inside its region, otherwise the bar's link
  const flip = boxOf('.block[data-hero="true"] .flip');
  const region = boxOf('.block[data-hero="true"] > article');
  const visible =
    flip && region && flip.y >= region.y - 1 && flip.y + flip.h <= region.y + region.h + 1;
  const target = visible ? flip : boxOf(".bar .make-link");
  if (!target) return null;
  const wide = window.innerWidth >= window.innerHeight * 0.9;
  const clear = visible && wide && region ? region : target;
  return { target, clear };
}

interface Drawn {
  target: Rect;
  card: { x: number; y: number };
  loop: string;
  shaft: string;
  head: string;
}

/**
 * The first-visit coach: three short notes, each pointing at the real thing with a hand-drawn marker
 * loop and arrow. It does not block the page (the veil lets every press through), so doing what a note
 * says moves on to the next; "next" and "skip" are there for anyone who would rather read. It is shown
 * once and can be opened again from the footer.
 */
export function Coach({
  steps,
  stages,
  hero,
  playing,
  auditioning,
  onClose,
}: {
  steps: readonly CoachStep[];
  stages: number;
  hero: number;
  /** Something is sounding: the first note has been done. */
  playing: boolean;
  /** The needle is being used on a stage: the second note has been done. */
  auditioning: boolean;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const step = steps[Math.min(index, steps.length - 1)]!;
  const last = index >= steps.length - 1;
  const text = copy.coach[step];

  // Doing what a note says moves on to the next. This is state derived from what the page is doing, so
  // it is adjusted while rendering (React re-renders at once), not in an effect.
  if ((step === "play" && playing) || (step === "needle" && auditioning)) {
    if (index < steps.length - 1) setIndex(index + 1);
  }

  // a visitor who got as far as the last note, or left in the middle, has seen it
  useEffect(() => {
    if (last) markCoachSeen();
  }, [last]);
  const close = useCallback(() => {
    markCoachSeen();
    onClose();
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const measure = useCallback((): void => {
    const found = targetFor(step, stages, hero);
    const card = cardRef.current;
    if (!found || !card) {
      setDrawn(null);
      return;
    }
    const size = { w: Math.min(CARD_W, window.innerWidth - 32), h: card.offsetHeight };
    const view = { w: window.innerWidth, h: window.innerHeight };
    const { target, clear } = found;
    const spot = placeCard(clear, size, view, 16, 28, PREFER[step]);
    const cardRect: Rect = { x: spot.x, y: spot.y, w: size.w, h: size.h };
    const targetCentre: Point = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    const cardCentre: Point = { x: cardRect.x + cardRect.w / 2, y: cardRect.y + cardRect.h / 2 };
    const from = edgeToward(cardRect, targetCentre, 4);
    const to = edgeToward(target, cardCentre, 12);
    const seed = 11 + index * 17;
    const arrow = arrowPath(from, to, seed);
    setDrawn({
      target,
      card: { x: spot.x, y: spot.y },
      loop: loopPath(target, 11, seed),
      shaft: arrow.shaft,
      head: arrow.head,
    });
  }, [step, stages, hero, index]);

  // the page under the note moves for a moment (the roll slides to a stage, fonts arrive), so measure
  // now and again as it settles, and on every resize
  useLayoutEffect(() => {
    measure();
    const timers = [120, 420, 900].map((ms) => window.setTimeout(measure, ms));
    window.addEventListener("resize", measure);
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(document.documentElement);
    return () => {
      for (const t of timers) window.clearTimeout(t);
      window.removeEventListener("resize", measure);
      watch?.disconnect();
    };
  }, [measure]);

  const count = useMemo(
    () => fill(copy.coach.count, { n: index + 1, total: steps.length }),
    [index, steps.length],
  );

  return (
    <div
      className="coach"
      role="group"
      aria-label={copy.coach.label}
      data-testid="coach"
      data-step={step}
    >
      <div
        className="coach-veil"
        aria-hidden="true"
        style={
          drawn
            ? ({
                "--sx": `${drawn.target.x + drawn.target.w / 2}px`,
                "--sy": `${drawn.target.y + drawn.target.h / 2}px`,
                "--sr": `${Math.max(drawn.target.w, drawn.target.h) / 2 + 22}px`,
              } as CSSProperties)
            : undefined
        }
      />
      {drawn ? (
        <svg
          className="coach-marks"
          width="100%"
          height="100%"
          viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
          aria-hidden="true"
          key={step}
        >
          <path className="mark" d={drawn.loop} pathLength={1} />
          <path className="mark" d={drawn.shaft} pathLength={1} />
          <path className="mark" d={drawn.head} pathLength={1} />
        </svg>
      ) : null}
      <section
        ref={cardRef}
        className="coach-card"
        style={{
          left: drawn?.card.x ?? 16,
          top: drawn?.card.y ?? 16,
          width: `min(${CARD_W}px, calc(100vw - 32px))`,
          visibility: drawn ? "visible" : "hidden",
        }}
      >
        <p className="coach-count">{count}</p>
        <h2 className="coach-title">{text.title}</h2>
        <p className="coach-body" role="status" aria-live="polite">
          {text.body}
        </p>
        <div className="coach-actions">
          {index > 0 ? (
            <button type="button" className="coach-back" onClick={() => setIndex(index - 1)}>
              {copy.coach.back}
            </button>
          ) : null}
          <button
            type="button"
            className="coach-next"
            onClick={() => (last ? close() : setIndex(index + 1))}
          >
            {last ? copy.coach.done : copy.coach.next}
          </button>
          {last ? null : (
            <button type="button" className="coach-skip" onClick={close}>
              {copy.coach.skip}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
