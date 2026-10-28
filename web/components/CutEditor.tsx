"use client";

import { useId, useMemo, useRef } from "react";
import { copy, fill } from "../lib/copy.ts";
import { type Cut, seconds, snapToZeroCrossing } from "../lib/make/cut.ts";
import { frameAt, keyStep, move } from "../lib/make/handles.ts";
import { outline, peaks } from "../lib/make/peaks.ts";

const BUCKETS = 600;
/** After a drag, a boundary moves to a zero crossing within 10 ms, an editing aid only. */
const SNAP_WINDOW = 480;

type Which = "start" | "end";

/**
 * The waveform of the sound with the two handles of the cut on it. Each handle is a slider: a
 * pointer drags it, the arrow keys move it a millisecond, and its value is said in seconds. A
 * handle may pass the other one; the cut then reads as inverted and the flow says so.
 */
export function CutEditor({
  samples,
  cut,
  onChange,
  onTouch,
}: {
  samples: Int16Array;
  cut: Cut;
  onChange: (cut: Cut) => void;
  /** A gesture on the editor: the flow starts or keeps the preview going. */
  onTouch: () => void;
}) {
  const clip = useId();
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<Which | null>(null);
  const total = samples.length;
  const shape = useMemo(() => outline(peaks(samples, BUCKETS)), [samples]);

  const set = (which: Which, frame: number) =>
    onChange(which === "start" ? { start: frame, end: cut.end } : { start: cut.start, end: frame });
  const at = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    return box ? frameAt(clientX, box.left, box.width, total) : 0;
  };
  const left = Math.min(cut.start, cut.end);
  const right = Math.max(cut.start, cut.end);
  const pct = (frame: number) => `${total === 0 ? 0 : (frame / total) * 100}%`;
  const inverted = cut.end <= cut.start;

  return (
    <div className="cut-editor">
      <div
        ref={track}
        className="track"
        data-inverted={inverted}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
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
          e.currentTarget.setPointerCapture(e.pointerId);
          onTouch();
          set(which, frame);
        }}
        onPointerMove={(e) => {
          if (dragging.current) set(dragging.current, at(e.clientX));
        }}
        onPointerUp={(e) => {
          const which = dragging.current;
          dragging.current = null;
          if (!which) return;
          set(which, snapToZeroCrossing(samples, at(e.clientX), SNAP_WINDOW));
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
      >
        <svg viewBox={`0 0 ${BUCKETS} 100`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect
                x={total === 0 ? 0 : (left / total) * BUCKETS}
                y="0"
                width={total === 0 ? 0 : ((right - left) / total) * BUCKETS}
                height="100"
              />
            </clipPath>
          </defs>
          <path className="wave-rest" d={shape} />
          <g clipPath={`url(#${clip})`}>
            <path className="wave-kept" d={shape} />
          </g>
        </svg>
        {(["start", "end"] as const).map((which) => {
          const frame = cut[which];
          return (
            <div
              key={which}
              className="handle"
              data-handle={which}
              role="slider"
              tabIndex={0}
              aria-label={copy.make.cut[which]}
              aria-describedby={`${clip}-help`}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={frame}
              aria-valuetext={`${seconds(frame)} seconds`}
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
      {/* the keyboard's part of the one-line hint above the editor, read out with each bracket */}
      <p className="help" id={`${clip}-help`}>
        {copy.make.cut.help}
      </p>
      <p className="readout" data-testid="cut-readout">
        {inverted
          ? `${seconds(cut.start)} to ${seconds(cut.end)}`
          : fill(copy.make.cut.range, {
              from: seconds(cut.start),
              to: seconds(cut.end),
              length: seconds(cut.end - cut.start),
            })}
      </p>
    </div>
  );
}
