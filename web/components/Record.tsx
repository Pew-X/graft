"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { copy, fill } from "../lib/copy.ts";
import { FrameGovernor } from "../lib/record/frames.ts";
import {
  RADIUS,
  angleFor,
  angleOf,
  bandAt,
  bandRadii,
  groovePoints,
  layout,
  offsetAt,
} from "../lib/record/geometry.ts";
import { moveCursor, type Cursor } from "../lib/record/keys.ts";
import type { Block } from "../lib/roll/view.ts";
import { dyes } from "../lib/theme/tokens.ts";

export interface Live {
  /** The stage the sound is in. */
  stage: number;
  /** Seconds into that stage's output. */
  position: number;
}

interface Props {
  blocks: readonly Block[];
  /** The loudest sample in each slice of each stage, for the grooves. */
  peaks: readonly (readonly number[])[];
  /** Where the sound is right now, read every frame without re-rendering; null when nothing is current. */
  live: () => Live | null;
  playing: boolean;
  /** Scrubbing is always an audition: these drive the engine. */
  onScrubStart: (stage: number, offset: number) => void;
  onScrubMove: (stage: number, offset: number) => void;
  onScrubEnd: () => void;
}

const POINTS = 96;

const toPath = (points: Array<[number, number]>): string =>
  points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ") +
  "Z";

/** Stretch or squeeze a list of peaks to `n` points. */
function resample(peaks: readonly number[], n: number): number[] {
  if (peaks.length === 0) return new Array<number>(n).fill(0);
  return Array.from({ length: n }, (_, i) => peaks[Math.floor((i * peaks.length) / n)] ?? 0);
}

/** A small trace of the stage's loudness across the label. */
function scope(peaks: readonly number[], hole: number): string {
  const n = 24;
  return resample(peaks, n)
    .map(
      (p, i) =>
        `${(-hole * 0.7 + (i / (n - 1)) * hole * 1.4).toFixed(2)},${(-p * hole * 0.4).toFixed(2)}`,
    )
    .join(" ");
}

/**
 * The record: the band is the stage, the angle along it is time within the stage, and the stylus is
 * the cursor. It is an instrument first (every action has a plain equivalent in the labels and the
 * controls) and a picture second. The grooves are drawn once and kept. Each frame moves the stylus
 * and the tonearm, lights the played part of the groove, and lets the groove under the stylus give
 * way; if frames run slow, the drawing keeps to the cached bands and stops doing the last of those.
 */
export function Record({
  blocks,
  peaks,
  live,
  playing,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: Props) {
  const stages = blocks.length;
  const geometry = useMemo(() => layout(stages), [stages]);
  const lengths = useMemo(() => blocks.map((b) => b.seconds), [blocks]);
  const rows = useMemo(
    () => blocks.map((_, i) => resample(peaks[i] ?? [], POINTS)),
    [blocks, peaks],
  );
  const grooves = useMemo(
    () => rows.map((row, i) => toPath(groovePoints(geometry, i, row))),
    [rows, geometry],
  );
  const [cursor, setCursor] = useState<Cursor>({ stage: 0, offset: 0 });
  const [hover, setHover] = useState<{ band: number | null; x: number; y: number } | null>(null);
  const [hint, setHint] = useState(true);
  const [mode, setMode] = useState<"live" | "cached">("live");
  const svg = useRef<SVGSVGElement>(null);
  const stylus = useRef<SVGGElement>(null);
  const arm = useRef<SVGLineElement>(null);
  const grooveEls = useRef<Array<SVGPathElement | null>>([]);
  const playedEls = useRef<Array<SVGPathElement | null>>([]);
  const totals = useRef<number[]>([]);
  const pushed = useRef<number | null>(null);
  const held = useRef<number | null>(null);
  const dragging = useRef(false);
  const governor = useRef(new FrameGovernor());

  useEffect(() => {
    totals.current = playedEls.current.map((el) => el?.getTotalLength() ?? 0);
  }, [grooves]);

  // The stylus rides the sound while it plays, else it rests at the cursor. Only SVG attributes
  // change per frame; nothing re-renders.
  useEffect(() => {
    let frame = 0;
    const restore = (): void => {
      if (pushed.current === null) return;
      const i = pushed.current;
      pushed.current = null;
      grooveEls.current[i]?.setAttribute("d", grooves[i] ?? "");
      playedEls.current[i]?.setAttribute("d", grooves[i] ?? "");
    };
    const draw = (timestamp: number): void => {
      governor.current.frame(timestamp);
      const degraded = governor.current.degraded;
      if (degraded) setMode("cached");
      const now = live();
      const where: Live = now ?? { stage: cursor.stage, position: cursor.offset };
      const band = Math.min(where.stage, stages - 1);
      const { mid } = bandRadii(geometry, band);
      const angle = angleFor(where.position, lengths[band] ?? 0);
      const x = mid * Math.sin(angle);
      const y = -mid * Math.cos(angle);
      stylus.current?.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      arm.current?.setAttribute("x2", x.toFixed(2));
      arm.current?.setAttribute("y2", y.toFixed(2));
      playedEls.current.forEach((el, i) => {
        if (!el) return;
        const total = totals.current[i] ?? 0;
        const fraction = i === band ? angle / (2 * Math.PI) : i < band ? 1 : 0;
        el.style.strokeDasharray = `${total * fraction} ${total}`;
      });
      // The groove gives way under the stylus; with slow frames it stays as cached.
      if (degraded) {
        restore();
      } else {
        if (pushed.current !== null && pushed.current !== band) restore();
        const d = toPath(groovePoints(geometry, band, rows[band] ?? [], { angle, strength: 1 }));
        grooveEls.current[band]?.setAttribute("d", d);
        playedEls.current[band]?.setAttribute("d", d);
        pushed.current = band;
      }
      if (playing) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [playing, live, cursor, geometry, lengths, stages, rows, grooves]);

  const locate = (event: PointerEvent): { x: number; y: number } | null => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return null;
    const scale = (2 * RADIUS) / box.width;
    return {
      x: (event.clientX - box.left - box.width / 2) * scale,
      y: (event.clientY - box.top - box.height / 2) * scale,
    };
  };
  const target = (x: number, y: number): { band: number; offset: number } | null => {
    const band = bandAt(geometry, Math.hypot(x, y), held.current);
    if (band === null) return null;
    return { band, offset: offsetAt(angleOf(x, y), lengths[band] ?? 0) };
  };

  const onDown = (event: PointerEvent<SVGSVGElement>): void => {
    const point = locate(event);
    const hit = point && target(point.x, point.y);
    if (!hit || hit.band >= stages) return; // the empty slot has no sound
    event.currentTarget.setPointerCapture(event.pointerId);
    held.current = hit.band;
    dragging.current = true;
    setHint(false);
    setCursor({ stage: hit.band, offset: hit.offset });
    onScrubStart(hit.band, hit.offset);
  };
  const onMove = (event: PointerEvent<SVGSVGElement>): void => {
    const point = locate(event);
    if (!point) return;
    const hit = target(point.x, point.y);
    if (dragging.current) {
      if (!hit) return;
      const band = Math.min(hit.band, stages - 1);
      held.current = band;
      setCursor({ stage: band, offset: hit.offset });
      onScrubMove(band, hit.offset);
    } else if (event.pointerType === "mouse") {
      setHover({ band: hit ? hit.band : null, ...point });
    }
  };
  const onUp = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    held.current = null;
    onScrubEnd();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setHint(false);
      onScrubStart(cursor.stage, cursor.offset);
      onScrubEnd();
      return;
    }
    const next = moveCursor(cursor, event.key, lengths);
    if (next) {
      event.preventDefault();
      setCursor(next);
    }
  };

  const shown = Math.min(cursor.stage, stages - 1);
  const block = blocks[shown];
  const dye = dyes[(block?.dye ?? 0) % dyes.length]!;
  const valueText = fill(copy.record.value, {
    n: shown + 1,
    total: stages,
    title: block?.title ?? "",
    at: cursor.offset.toFixed(1),
    length: (lengths[shown] ?? 0).toFixed(1),
  });
  const named = hover && hover.band !== null && hover.band < stages ? hover.band : null;

  return (
    <div className="record" data-record={mode}>
      <svg
        ref={svg}
        viewBox={`${-RADIUS} ${-RADIUS} ${2 * RADIUS} ${2 * RADIUS}`}
        role="slider"
        tabIndex={0}
        aria-label={copy.record.label}
        aria-valuemin={0}
        aria-valuemax={Math.round((lengths[shown] ?? 0) * 1000)}
        aria-valuenow={Math.round(cursor.offset * 1000)}
        aria-valuetext={valueText}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
      >
        <circle r={RADIUS} className="disc" />
        {blocks.map((b, i) => (
          <g key={b.id} className="band" data-stage={i}>
            <circle
              r={bandRadii(geometry, i).mid}
              className="track"
              strokeWidth={geometry.thickness * 0.8}
              stroke={dyes[b.dye % dyes.length]!.fill}
            />
            <path
              d={grooves[i]}
              className="groove"
              ref={(el) => {
                grooveEls.current[i] = el;
              }}
            />
            <path
              d={grooves[i]}
              className="played"
              ref={(el) => {
                playedEls.current[i] = el;
              }}
            />
          </g>
        ))}
        <circle
          r={bandRadii(geometry, stages).mid}
          className="empty-slot"
          strokeWidth={geometry.thickness * 0.8}
        />
        <g className="label">
          <circle r={geometry.hole} fill={dye.fill} />
          <text className="label-numeral" textAnchor="middle" dy="0.35em" fill={dye.text}>
            {block?.numeral}
          </text>
          <polyline className="scope" points={scope(peaks[shown] ?? [], geometry.hole)} />
        </g>
        {named !== null ? <circle r={bandRadii(geometry, named).mid} className="ghost" /> : null}
        <line ref={arm} className="tonearm" x1="92" y1="-96" x2="0" y2="0" />
        <g ref={stylus} className="stylus">
          <circle r="3.2" />
        </g>
        {hover ? <circle className="hover-stylus" r="3.2" cx={hover.x} cy={hover.y} /> : null}
      </svg>
      <p className="record-caption" aria-hidden="true">
        {named !== null
          ? fill(copy.record.hover, { n: named + 1, title: blocks[named]?.title ?? "" })
          : hint
            ? copy.record.needle
            : ""}
      </p>
    </div>
  );
}
