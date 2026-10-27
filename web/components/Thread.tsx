"use client";

import { useEffect, useRef } from "react";
import { layout, needleAt } from "../lib/record/disc.ts";
import { threadPath } from "../lib/thread/thread.ts";
import { traceOf } from "../lib/trace/trace.ts";

const POINTS = 96;
const WOBBLE = 9;
/** After the stage in view changes the roll slides for a moment; the cable follows it. */
const FOLLOW_MS = 900;

/**
 * The thread: a patch cable from the stage in view (its trace, at the top of its label) to that stage's
 * groove on the record, carrying the same trace as its wobble. It ties the words to the ring, so the
 * stage on the left is plainly the ring on the right, and it moves when the stage in view does. It is
 * drawn only where the label and the record sit side by side; on a phone the record is below the label
 * and the cable would run across the credits. Pure decoration: never read out, never in the way.
 */
export function Thread({ id, hero, stages }: { id: string; hero: number; stages: number }) {
  const root = useRef<SVGSVGElement>(null);

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
    <svg ref={root} className="thread" aria-hidden="true" data-shown="false" data-testid="thread">
      <path className="under" />
      <path className="glow" />
      <path className="beam" />
      <path className="pulse" pathLength={1000} />
      <circle className="jack" r="6" />
      <circle className="jack" r="6" />
    </svg>
  );
}
