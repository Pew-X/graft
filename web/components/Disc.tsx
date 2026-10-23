"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { copy, fill } from "../lib/copy.ts";
import { hit, layout } from "../lib/record/disc.ts";
import { FrameGovernor } from "../lib/record/frames.ts";
import { moveCursor, type Cursor } from "../lib/record/keys.ts";
import {
  groovesIn,
  paintGrooves,
  paintOverlay,
  type Scene,
  type StageLook,
} from "../lib/record/paint.ts";
import type { Block } from "../lib/roll/view.ts";
import { useResolvedTheme } from "../lib/theme/use-theme.ts";
import { dyes } from "../lib/theme/tokens.ts";

export interface Live {
  /** The stage the sound is in. */
  stage: number;
  /** Seconds into that stage's output. */
  position: number;
}

interface Props {
  blocks: readonly Block[];
  /** Length of each stage's audio in seconds (0 for a stage with none). */
  lengths: readonly number[];
  /** Whether each stage can be heard; the others are drawn but do nothing when touched. */
  playable: readonly boolean[];
  /** The loudest sample in each slice of each stage, for the grooves. */
  peaks: readonly (readonly number[])[];
  /** Where the sound is right now, read every frame without re-rendering; null when nothing is current. */
  live: () => Live | null;
  playing: boolean;
  reduced: boolean;
  /** The stage the page is showing (the one playing, or the one the visitor moved to). */
  focus: number;
  /** Scrubbing is always an audition: these drive the engine. */
  onScrubStart: (stage: number, offset: number) => void;
  onScrubMove: (stage: number, offset: number) => void;
  onScrubEnd: () => void;
}

const SAMPLE_RATE = 48_000;
const DISC_TURNS_PER_SECOND = 0.55; // 33 and a third revolutions a minute

/**
 * The record: the locked look, drawn on a canvas that fills the screen behind the credits. It is an
 * instrument first (every action has a plain equivalent in the labels and controls) and a picture
 * second. It draws only when something changes, or every frame while the disc turns. If frames run
 * slow it stops turning and stops pushing the groove under the stylus and reuses a drawn copy of the
 * grooves, redrawn only when the playhead passes a groove.
 */
export function Disc({
  blocks,
  lengths,
  playable,
  peaks,
  live,
  playing,
  reduced,
  focus,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: Props) {
  const stages = blocks.length;
  const theme = useResolvedTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState<Cursor>({ stage: Math.min(focus, stages - 1), offset: 0 });
  const [mode, setMode] = useState<"live" | "cached">("live");
  const [hint, setHint] = useState(true);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cache = useRef<{ key: string; bitmap: HTMLCanvasElement } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const held = useRef<number | null>(null);
  const dragging = useRef(false);
  const clock = useRef(0);
  const governor = useRef(new FrameGovernor());
  const frame = useRef(0);
  const latest = useRef({ cursor, focus, playing });
  useLayoutEffect(() => {
    latest.current = { cursor, focus, playing };
  });

  const looks = useMemo<StageLook[]>(
    () =>
      blocks.map((b, i) => {
        const next = blocks[i + 1];
        const frames = (lengths[i] ?? 0) * SAMPLE_RATE;
        const kept = next?.cutFrames ?? null;
        return {
          dye: dyes[b.dye % dyes.length]!.fill,
          peaks: peaks[i] ?? [],
          cut:
            kept && frames > 0
              ? [Math.min(1, kept[0] / frames), Math.min(1, kept[1] / frames)]
              : null,
        };
      }),
    [blocks, lengths, peaks],
  );

  // Size follows the box the canvas fills (the dynamic viewport, so a phone's address bar is counted).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const draw = useCallback(
    (timestamp: number): void => {
      const el = canvas.current;
      if (!el || size.w === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (el.width !== Math.round(size.w * dpr) || el.height !== Math.round(size.h * dpr)) {
        el.width = Math.round(size.w * dpr);
        el.height = Math.round(size.h * dpr);
        cache.current = null;
      }
      const ctx = el.getContext("2d");
      if (!ctx) return;
      governor.current.frame(timestamp);
      const slow = governor.current.degraded;
      if (slow) setMode((m) => (m === "cached" ? m : "cached"));
      const { cursor: at, focus: shown, playing: sounding } = latest.current;
      const now = live();
      const stage = Math.min(now?.stage ?? (sounding ? shown : at.stage), stages - 1);
      const length = lengths[stage] ?? 0;
      const position = now?.position ?? (stage === at.stage ? at.offset : 0);
      const u = length > 0 ? Math.min(1, Math.max(0, position / length)) : 0;
      const scene: Scene = {
        width: size.w,
        height: size.h,
        theme,
        stages: looks,
        active: stage,
        u,
        rotation: clock.current * Math.PI * 2 * DISC_TURNS_PER_SECOND,
        clock: clock.current,
        pointer: pointer.current,
        hover: null,
        reduced,
        cached: slow,
      };
      const l = layout(size.w, size.h, stages);
      const over = pointer.current ? hit(l, pointer.current.x, pointer.current.y, null) : null;
      if (over) {
        scene.hover = {
          band: over.band,
          name: `${String(over.band + 1).padStart(2, "0")} · ${blocks[over.band]?.title ?? copy.end.value}`,
        };
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      if (slow) {
        // The drawn copy of the grooves, redrawn only when the playhead passes a groove.
        const step = Math.floor(u * (groovesIn(l) - 1));
        const key = `${size.w}x${size.h}|${theme}|${stage}|${step}|${stages}|${peaks.length}`;
        if (cache.current?.key !== key) {
          const bitmap = cache.current?.bitmap ?? document.createElement("canvas");
          bitmap.width = el.width;
          bitmap.height = el.height;
          const off = bitmap.getContext("2d");
          if (off) {
            off.setTransform(dpr, 0, 0, dpr, 0, 0);
            paintGrooves(off, { ...scene, pointer: null });
          }
          cache.current = { key, bitmap };
        }
        ctx.drawImage(cache.current.bitmap, 0, 0, size.w, size.h);
      } else {
        paintGrooves(ctx, scene);
      }
      paintOverlay(ctx, scene);
    },
    [size, theme, looks, lengths, stages, reduced, live, blocks, peaks.length],
  );

  // Draw once whenever something changes, and every frame while the disc is turning.
  useEffect(() => {
    let last = performance.now();
    const tick = (timestamp: number): void => {
      if (latest.current.playing) clock.current += Math.min(0.1, (timestamp - last) / 1000);
      last = timestamp;
      draw(timestamp);
      if (latest.current.playing || dragging.current) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [draw, playing, cursor, focus]);

  const redraw = (): void => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame((t) => draw(t));
  };

  const locate = (event: PointerEvent): { x: number; y: number } | null => {
    const box = canvas.current?.getBoundingClientRect();
    return box ? { x: event.clientX - box.left, y: event.clientY - box.top } : null;
  };
  const target = (x: number, y: number): { band: number; offset: number } | null => {
    const h = hit(layout(size.w, size.h, stages), x, y, held.current);
    if (!h) return null;
    const band = Math.min(h.band, stages - 1);
    return { band: h.band, offset: h.u * (lengths[band] ?? 0) };
  };

  const onDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    const point = locate(event);
    const hitAt = point && target(point.x, point.y);
    if (!hitAt || hitAt.band >= stages || playable[hitAt.band] === false) return; // no sound there
    event.currentTarget.setPointerCapture(event.pointerId);
    held.current = hitAt.band;
    dragging.current = true;
    pointer.current = point;
    setHint(false);
    setCursor({ stage: hitAt.band, offset: hitAt.offset });
    onScrubStart(hitAt.band, hitAt.offset);
    redraw();
  };
  const onMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const point = locate(event);
    if (!point) return;
    if (dragging.current) {
      const hitAt = target(point.x, point.y);
      pointer.current = point;
      if (hitAt) {
        const band = Math.min(hitAt.band, stages - 1);
        if (playable[band] !== false) {
          held.current = band;
          setCursor({ stage: band, offset: hitAt.offset });
          onScrubMove(band, hitAt.offset);
        }
      }
    } else if (event.pointerType === "mouse") {
      pointer.current = point;
      // The stylus replaces the pointer over the record, and only there.
      const over = hit(layout(size.w, size.h, stages), point.x, point.y, null) !== null;
      event.currentTarget.style.cursor = over ? "none" : "default";
    }
    if (!latest.current.playing) redraw();
  };
  const onUp = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    held.current = null;
    pointer.current = null;
    onScrubEnd();
    redraw();
  };
  const onLeave = (): void => {
    if (dragging.current) return;
    pointer.current = null;
    redraw();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setHint(false);
      if (playable[cursor.stage] === false) return; // nothing to hear there
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
  const valueText = fill(copy.record.value, {
    n: shown + 1,
    total: stages,
    title: block?.title ?? "",
    at: cursor.offset.toFixed(1),
    length: (lengths[shown] ?? 0).toFixed(1),
  });

  return (
    <div className="record" data-record={mode} ref={wrap}>
      <canvas
        ref={canvas}
        className="disc"
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
        onPointerLeave={onLeave}
        onKeyDown={onKey}
      />
      {hint ? (
        <p className="record-caption" aria-hidden="true">
          {copy.record.needle}
        </p>
      ) : null}
    </div>
  );
}
