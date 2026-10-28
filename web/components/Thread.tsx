"use client";

import { useEffect, useRef } from "react";
import { layout, needleAt } from "../lib/record/disc.ts";
import { threadPath } from "../lib/thread/thread.ts";
import { traceOf } from "../lib/trace/trace.ts";

const POINTS = 96;
const WOBBLE = 9;
/** After the stage in view changes the roll slides for a moment; the cable follows it. */
const FOLLOW_MS = 320;
/** How fast the line's brightness follows the loudness, per frame (0 to 1): quick enough to read as the sound, slow enough not to flicker. */
const EASE = 0.22;

/**
 * The thread: a patch cable from the stage in view (its trace, at the top of its label) to that stage's
 * groove on the record, carrying the same trace as its wobble. It exists only while that stage sounds
 * (`on`): then it is drawn in the stage's own colour, thin, and brightens with the stage's loudness at
 * the playhead (`level`), so the stage on the left is plainly the ring on the right and the line carries
 * something real. At rest it is gone. It is drawn only where the label and the record sit side by side; on
 * a phone the record is below the label and the cable would run across the credits. Never read out, never
 * in the way.
 */
export function Thread({
  id,
  hero,
  stages,
  on,
  level,
  reduced,
}: {
  id: string;
  hero: number;
  stages: number;
  /** The stage on screen is sounding. */
  on: boolean;
  /** How loud the stage is at the playhead, 0 to 1. */
  level: () => number;
  reduced: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);

  // the line's brightness follows the sound, only while it is shown; reduced motion gets a steady line
  useEffect(() => {
    const svg = root.current;
    if (!svg) return undefined;
    if (!on) {
      svg.style.setProperty("--amp", "0");
      return undefined;
    }
    if (reduced) {
      svg.style.setProperty("--amp", "0.5");
      return undefined;
    }
    let frame = 0;
    let amp = 0;
    const tick = (): void => {
      amp += (level() - amp) * EASE;
      svg.style.setProperty("--amp", amp.toFixed(3));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [on, reduced, level]);

  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    const values = traceOf(id, POINTS);
    let frame = 0;
    const draw = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const l = layout(w, h, Math.max(1, stages));
      const chip = document.querySelector('.block[data-hero="true"] .trace-face');
      const box = chip?.getBoundingClientRect();
      if (l.portrait || !box || box.width < 1 || box.bottom < 0 || box.top > h) {
        svg.dataset["shown"] = "false";
        return;
      }
      const from = { x: box.right, y: box.top + box.height / 2 };
      const to = needleAt(l, hero, 0.5);
      const d = threadPath(from, to, values, WOBBLE);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      for (const p of svg.querySelectorAll("path")) p.setAttribute("d", d);
      const jacks = svg.querySelectorAll("circle");
      jacks[0]?.setAttribute("cx", String(from.x));
      jacks[0]?.setAttribute("cy", String(from.y));
      jacks[1]?.setAttribute("cx", String(to.x));
      jacks[1]?.setAttribute("cy", String(to.y));
      svg.dataset["shown"] = "true";
    };
    const follow = (): void => {
      window.cancelAnimationFrame(frame);
      const until = performance.now() + FOLLOW_MS;
      const tick = (): void => {
        draw();
        if (performance.now() < until) frame = window.requestAnimationFrame(tick);
      };
      tick();
    };
    follow();
    window.addEventListener("resize", follow);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", follow);
    };
  }, [id, hero, stages]);

  return (
    <svg
      ref={root}
      className="thread"
      aria-hidden="true"
      data-shown="false"
      data-on={on}
      data-testid="thread"
    >
      <path className="edge" />
      <path className="beam" />
      <path className="pulse" pathLength={1000} />
      <circle className="jack" r="6" />
      <circle className="jack" r="6" />
    </svg>
  );
}
