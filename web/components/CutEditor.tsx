"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { copy, fill } from "../lib/copy.ts";
import { type Cut, seconds, snapToZeroCrossing } from "../lib/make/cut.ts";
import { keyStep, move } from "../lib/make/handles.ts";
import { outline, peaks } from "../lib/make/peaks.ts";
import { playheadFrame, steppedFraction } from "../lib/make/playhead.ts";
import {
  type View,
  fractionOf,
  frameInView,
  isWhole,
  MIN_SPAN,
  panBy,
  pinchFactor,
  viewAround,
  wheelFactor,
  wholeView,
  zoomAt,
} from "../lib/make/view.ts";

const BUCKETS = 600;
/** After a drag, a boundary moves to a zero crossing within 10 ms, an editing aid only. */
const SNAP_WINDOW = 480;

type Which = "start" | "end";

/**
 * The waveform of the sound with the two handles of the cut on it. Each handle is a slider: a
 * pointer drags it, the arrow keys move it a millisecond, and its value is said in seconds. A
 * handle may pass the other one; the cut then reads as inverted and the flow says so.
 *
 * Two aids for placing a bracket exactly. A line follows what is playing (the preview loops the
 * kept part at a constant speed, so the position in the loop is the position on the cut). And a
 * zoom, off until asked for, shows a closer window of the sound; the brackets still hold frames of
 * the whole sound, so zooming never changes what a cut means.
 */
export function CutEditor({
  samples,
  cut,
  onChange,
  onTouch,
  playhead,
}: {
  samples: Int16Array;
  cut: Cut;
  onChange: (cut: Cut) => void;
  /** A gesture on the editor: the flow starts or keeps the preview going. */
  onTouch: () => void;
  /** How far through the loop now playing the sound is (0 up to 1), or null when nothing plays. */
  playhead?: () => number | null;
}) {
  const clip = useId();
  const track = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const dragging = useRef<Which | null>(null);
  const fingers = useRef(new Map<number, number>());
  const pinch = useRef<number | null>(null);
  const total = samples.length;
  const [zoomed, setZoomed] = useState(false);
  const [zoomWindow, setWindow] = useState<View>(() => wholeView(total));
  // a different sound is shown whole
  const [forTotal, setForTotal] = useState(total);
  if (forTotal !== total) {
    setForTotal(total);
    setZoomed(false);
    setWindow(wholeView(total));
  }
  const view: View = zoomed ? zoomWindow : wholeView(total);
  const whole = isWhole(view, total);

  const shape = useMemo(() => {
    const part = whole ? samples : samples.subarray(view.from, view.to);
    return outline(peaks(part, BUCKETS));
  }, [samples, view.from, view.to, whole]);

  const set = (which: Which, frame: number) => {
    onChange(which === "start" ? { start: frame, end: cut.end } : { start: cut.start, end: frame });
    // a bracket moved by key past the edge of the window brings the window with it
    if (zoomed && (frame < view.from || frame > view.to)) {
      setWindow(panBy(view, total, frame < view.from ? frame - view.from : frame - view.to));
    }
  };
  const at = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    return box ? frameInView(clientX, box.left, box.width, view) : 0;
  };
  const left = Math.min(cut.start, cut.end);
  const right = Math.max(cut.start, cut.end);
  const span = view.to - view.from;
  const pctOf = (frame: number): number =>
    span <= 0 ? 0 : Math.max(0, Math.min(100, fractionOf(frame, view) * 100));
  const pct = (frame: number) => `${pctOf(frame)}%`;
  const inverted = cut.end <= cut.start;
  const keptFrom = span <= 0 ? 0 : Math.max(0, Math.min(1, fractionOf(left, view))) * BUCKETS;
  const keptTo = span <= 0 ? 0 : Math.max(0, Math.min(1, fractionOf(right, view))) * BUCKETS;

  const zoomTo = useCallback(
    (anchor: number, factor: number) =>
      setWindow((w) => {
        const base = isWhole(w, total) || !zoomed ? wholeView(total) : w;
        return zoomAt(base, total, anchor, factor);
      }),
    [total, zoomed],
  );

  const toggleZoom = () => {
    if (zoomed) {
      setZoomed(false);
      setWindow(wholeView(total));
    } else {
      setZoomed(true);
      setWindow(viewAround(cut.start, cut.end, total));
    }
  };

  // The wheel zooms around the pointer while zoom is on. It must be a native listener: a React one is
  // passive and could not keep the page from scrolling.
  const latest = useRef({ view, total, zoomTo, cut });
  useEffect(() => {
    latest.current = { view, total, zoomTo, cut };
  });
  useEffect(() => {
    const el = track.current;
    if (!zoomed || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, total: n, zoomTo: zoom } = latest.current;
      const box = el.getBoundingClientRect();
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal) {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        setWindow((w) => panBy(w, n, (delta / Math.max(1, box.width)) * (v.to - v.from)));
        return;
      }
      zoom(frameInView(e.clientX, box.left, box.width, v), wheelFactor(e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomed]);

  // The line that follows what is playing. It moves by style on a ref, so it never re-renders the editor.
  useEffect(() => {
    const el = line.current;
    if (!playhead || !el) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = () => {
      const raw = playhead();
      if (raw === null) {
        el.dataset["on"] = "false";
        return;
      }
      const f = reduced ? steppedFraction(raw) : raw;
      const frame = playheadFrame(latest.current.cut, f);
      const where = fractionOf(frame, latest.current.view);
      el.dataset["on"] = where >= 0 && where <= 1 ? "true" : "false";
      el.dataset["frame"] = String(Math.round(frame));
      el.style.left = `${Math.max(0, Math.min(1, where)) * 100}%`;
    };
    paint();
    if (reduced) {
      const timer = window.setInterval(paint, 250);
      return () => window.clearInterval(timer);
    }
    let raf = 0;
    const tick = () => {
      paint();
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playhead]);

  const stepZoom = (factor: number) => {
    onTouch();
    zoomTo(Math.round((view.from + view.to) / 2), factor);
  };

  return (
    <div className="cut-editor">
      <div className="zoom-bar">
        <button
          type="button"
          className="pill"
          aria-pressed={zoomed}
          data-testid="zoom-toggle"
          onClick={toggleZoom}
        >
          {copy.make.cut.zoom.toggle}
        </button>
        {zoomed ? (
          <>
            <button
              type="button"
              className="pill"
              aria-label={copy.make.cut.zoom.out}
              disabled={whole}
              onClick={() => stepZoom(1 / 2)}
            >
              −
            </button>
            <button
              type="button"
              className="pill"
              aria-label={copy.make.cut.zoom.in}
              disabled={span <= MIN_SPAN}
              onClick={() => stepZoom(2)}
            >
              +
            </button>
            <button
              type="button"
              className="pill"
              onClick={() => setWindow(viewAround(cut.start, cut.end, total))}
            >
              {copy.make.cut.zoom.fit}
            </button>
          </>
        ) : (
          <span className="gloss">{copy.make.cut.zoom.gloss}</span>
        )}
      </div>
      <div
        ref={track}
        className="track"
        data-inverted={inverted}
        data-zoomed={zoomed}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          fingers.current.set(e.pointerId, e.clientX);
          e.currentTarget.setPointerCapture(e.pointerId);
          if (zoomed && fingers.current.size === 2) {
            // two fingers: a pinch, not a drag
            dragging.current = null;
            const [a = 0, b = 0] = [...fingers.current.values()];
            pinch.current = Math.abs(a - b);
            return;
          }
          const frame = at(e.clientX);
          const named = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset[
            "handle"
          ];
          const which: Which =
            named === "start" || named === "end"
              ? named
              : Math.abs(frame - cut.start) <= Math.abs(frame - cut.end)
                ? "start"
                : "end";
          dragging.current = which;
          onTouch();
          set(which, frame);
        }}
        onPointerMove={(e) => {
          if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, e.clientX);
          if (pinch.current !== null && fingers.current.size === 2) {
            const [a = 0, b = 0] = [...fingers.current.values()];
            const now = Math.abs(a - b);
            const box = track.current?.getBoundingClientRect();
            if (box) {
              zoomTo(
                frameInView((a + b) / 2, box.left, box.width, view),
                pinchFactor(pinch.current, now),
              );
            }
            pinch.current = now;
            return;
          }
          if (dragging.current) set(dragging.current, at(e.clientX));
        }}
        onPointerUp={(e) => {
          fingers.current.delete(e.pointerId);
          if (pinch.current !== null) {
            if (fingers.current.size < 2) pinch.current = null;
            dragging.current = null;
            return;
          }
          const which = dragging.current;
          dragging.current = null;
          if (!which) return;
          set(which, snapToZeroCrossing(samples, at(e.clientX), SNAP_WINDOW));
        }}
        onPointerCancel={(e) => {
          fingers.current.delete(e.pointerId);
          if (fingers.current.size < 2) pinch.current = null;
          dragging.current = null;
        }}
      >
        <svg viewBox={`0 0 ${BUCKETS} 100`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect x={keptFrom} y="0" width={Math.max(0, keptTo - keptFrom)} height="100" />
            </clipPath>
          </defs>
          <path className="wave-rest" d={shape} />
          <g clipPath={`url(#${clip})`}>
            <path className="wave-kept" d={shape} />
          </g>
        </svg>
        <div
          ref={line}
          className="playhead"
          data-on="false"
          data-testid="playhead"
          aria-hidden="true"
        />
        {(["start", "end"] as const).map((which) => {
          const frame = cut[which];
          const out = frame < view.from ? "before" : frame > view.to ? "after" : "in";
          return (
            <div
              key={which}
              className="handle"
              data-handle={which}
              data-offscreen={out === "in" ? undefined : out}
              role="slider"
              tabIndex={0}
              aria-label={copy.make.cut[which]}
              aria-describedby={`${clip}-help`}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={frame}
              aria-valuetext={`${seconds(frame)} seconds${out === "in" ? "" : `, ${copy.make.cut.zoom.offscreen}`}`}
              style={{ left: pct(frame) }}
              onKeyDown={(e) => {
                const home = e.key === "Home";
                const end = e.key === "End";
                const delta = keyStep(e.key, e.shiftKey);
                if (!home && !end && delta === null) return;
                e.preventDefault();
                onTouch();
                set(which, home ? 0 : end ? total : move(frame, delta ?? 0, total));
              }}
            >
              <span className="grip" aria-hidden="true" />
              <span className="tag" aria-hidden="true">
                {copy.make.cut.tag[which]}
              </span>
            </div>
          );
        })}
      </div>
      <p className="readout" data-testid="cut-readout">
        {inverted
          ? `${seconds(cut.start)} to ${seconds(cut.end)}`
          : fill(copy.make.cut.range, {
              from: seconds(cut.start),
              to: seconds(cut.end),
              length: seconds(cut.end - cut.start),
            })}
      </p>
      {zoomed ? (
        <p className="help" data-testid="zoom-window">
          {fill(copy.make.cut.zoom.showing, { from: seconds(view.from), to: seconds(view.to) })}{" "}
          {copy.make.cut.zoom.hint}
        </p>
      ) : null}
      {/* what the keyboard does to the brackets: seen, and read out with each bracket */}
      <p className="help" id={`${clip}-help`}>
        {copy.make.cut.help}
      </p>
    </div>
  );
}
