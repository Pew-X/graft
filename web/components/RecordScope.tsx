"use client";

import { useEffect, useRef } from "react";
import { FrameGovernor } from "../lib/record/frames.ts";
import { beamLevel, delayPairs, delaySamples, nextGain, readout } from "../lib/own/scope.ts";

/** The house screen and beam (the trace tile's own values): always dark, as a real one is, in both themes. */
const SCREEN = "#070908";
const BEAM = "#5dff9c";
/** Where the beam is brightest it runs white-hot, as a phosphor does where it is hit hardest. */
const HOT = "#d9ffe8";
/** How much of the last frame the next one leaves lit: the afterglow, a few tenths of a second. */
const FADE = 0.15;
const FFT = 2048;
/** The screen is ten by eight divisions of a 4:3 tube; the picture keeps to the middle of it. */
const COLS = 8;
const ROWS = 6;

interface Tap {
  context: AudioContext;
  analyser: AnalyserNode;
}

/** The microphone's stream into one analyser, past a high-pass that removes rumble. Never connected to the speakers. */
function tap(stream: MediaStream): Tap | null {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const source = context.createMediaStreamSource(stream);
  const rumble = context.createBiquadFilter();
  rumble.type = "highpass";
  rumble.frequency.value = 70;
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT;
  analyser.smoothingTimeConstant = 0;
  source.connect(rumble);
  rumble.connect(analyser);
  return { context, analyser };
}

/**
 * The recording scope: an oscilloscope in X-Y mode, the glowing loops of a vintage tape machine on a tube.
 * The sound drives both axes: x is the microphone now, y is the microphone a moment earlier, so a steady
 * tone is an ellipse, a louder one a bigger one, a rising pitch a faster turn, and speech a living tangle.
 * The beam leaves an afterglow, runs dimmer where it moves fast and white-hot where it lingers or crosses
 * itself. The graticule and the glass are a second, still canvas laid over the beam's, as a real one is a
 * sheet in front of the tube. It draws only what the sound is: silence is a dot.
 */
export function RecordScope({ stream }: { stream: MediaStream }) {
  const beam = useRef<HTMLCanvasElement>(null);
  const bloom = useRef<HTMLCanvasElement>(null);
  const sheet = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const beamEl = beam.current;
    const sheetEl = sheet.current;
    const bloomEl = bloom.current;
    const box = wrap.current;
    if (!beamEl || !sheetEl || !bloomEl || !box) return undefined;
    const tapped = tap(stream);
    if (!tapped) return undefined;
    const { context, analyser } = tapped;
    void context.resume().catch(() => undefined);
    const rate = context.sampleRate;
    const delay = delaySamples(rate);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const governor = new FrameGovernor();
    const data = new Float32Array(FFT);
    let gain = 1;
    let width = 0;
    let height = 0;
    let frame = 0;
    let frames = 0;
    let last = 0;
    let alive = true;

    const size = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(160, Math.round(box.clientWidth));
      height = Math.round((width * ROWS) / COLS);
      for (const el of [beamEl, sheetEl]) {
        el.width = Math.round(width * dpr);
        el.height = Math.round(height * dpr);
        el.style.height = `${height}px`;
      }
      bloomEl.width = Math.max(1, Math.round(width / 4));
      bloomEl.height = Math.max(1, Math.round(height / 4));
      bloomEl.style.height = `${height}px`;
      const b = beamEl.getContext("2d");
      if (b) {
        b.setTransform(dpr, 0, 0, dpr, 0, 0);
        b.fillStyle = SCREEN;
        b.fillRect(0, 0, width, height);
      }
      const s = sheetEl.getContext("2d");
      if (s) {
        s.setTransform(dpr, 0, 0, dpr, 0, 0);
        glass(s, width, height, readout(rate));
      }
    };
    size();
    const watch = new ResizeObserver(size);
    watch.observe(box);

    const draw = (timestamp: number): void => {
      if (!alive) return;
      frame = requestAnimationFrame(draw);
      governor.frame(timestamp);
      // a slow machine draws every other frame, and a visitor who asks for less motion gets a calm, steady one
      if ((governor.degraded || reduced) && frames % 2 === 1) {
        frames++;
        return;
      }
      frames++;
      const ctx = beamEl.getContext("2d");
      if (!ctx || width === 0) return;
      // the newest stretch of sound, as long as the time since the last frame, so the beam is one line
      // from frame to frame and not a set of pieces
      const since = last === 0 ? 16 : Math.min(60, timestamp - last);
      last = timestamp;
      analyser.getFloatTimeDomainData(data);
      const count = Math.min(FFT, Math.round((since / 1000) * rate) + delay + 8);
      const fresh = data.subarray(FFT - count);
      let peak = 0;
      for (const v of fresh) peak = Math.max(peak, Math.abs(v));
      gain = nextGain(gain, peak);
      const pairs = delayPairs(fresh, delay, gain);

      // the afterglow: the last frame is dimmed, not wiped
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = reduced ? SCREEN : `rgba(7, 9, 8, ${FADE})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.46;
      // segments are gathered by how bright the beam is over them: a few strokes, not a thousand
      const buckets: Array<Array<[number, number, number, number]>> = [[], [], [], []];
      let px = cx + (pairs[0]?.x ?? 0) * radius;
      let py = cy - (pairs[0]?.y ?? 0) * radius;
      for (let i = 1; i < pairs.length; i++) {
        const p = pairs[i]!;
        const x = cx + p.x * radius;
        const y = cy - p.y * radius;
        const level = beamLevel(Math.hypot(x - px, y - py));
        buckets[level > 0.75 ? 0 : level > 0.5 ? 1 : level > 0.33 ? 2 : 3]!.push([px, py, x, y]);
        px = x;
        py = y;
      }
      if (pairs.length === 1 || pairs.length === 0) {
        // silence: the beam sits as a point
        ctx.fillStyle = BEAM;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      const alphas = [1, 0.62, 0.38, 0.2];
      for (let b = buckets.length - 1; b >= 0; b--) {
        const segs = buckets[b]!;
        if (segs.length === 0) continue;
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of segs) {
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        const a = alphas[b] ?? 0.2;
        // the halo, the glow, the body, then the core: where the beam is brightest it runs white-hot, with
        // green only at its edge, as a phosphor does
        // the glow adds light (a lit phosphor glows over a lit one); the line itself is painted, so a
        // curve drawn again and again stays a line and does not run to a white disc
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = BEAM;
        ctx.globalAlpha = a * 0.05;
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.globalAlpha = a * 0.14;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = Math.min(1, a * 0.7);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (b === 0) {
          ctx.strokeStyle = HOT;
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // the bloom: a small copy of the picture, which the page blurs and lays over it, lights the glass round the figure
      const bctx = bloomEl.getContext("2d");
      if (bctx) {
        bctx.globalCompositeOperation = "copy";
        bctx.drawImage(beamEl, 0, 0, bloomEl.width, bloomEl.height);
      }
      box.dataset["frames"] = String(frames);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      watch.disconnect();
      // the context goes with the scope: an open one would keep the browser's recording light on
      void context.close().catch(() => undefined);
    };
  }, [stream]);

  return (
    <div className="record-scope" ref={wrap} data-testid="record-scope" aria-hidden="true">
      <canvas ref={beam} className="scope-beam" />
      <canvas ref={bloom} className="scope-bloom" />
      <canvas ref={sheet} className="scope-sheet" />
    </div>
  );
}

/** A small noise tile from a fixed seed, so the glass is the same every time (no random look to the eye). */
function grain(size: number): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 200;
    image.data[i + 1] = 255;
    image.data[i + 2] = 220;
    image.data[i + 3] = Math.floor(next() * 22);
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

/**
 * The sheet in front of the tube: a graticule of eight by six divisions with a centre cross ticked five to
 * a division, the glass (a dark vignette at the corners, a soft glare, a fine grain), and what the two axes are.
 */
function glass(ctx: CanvasRenderingContext2D, width: number, height: number, axes: string): void {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = BEAM;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.11;
  ctx.beginPath();
  for (let i = 0; i <= COLS; i++) {
    const x = Math.round((width * i) / COLS) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let j = 0; j <= ROWS; j++) {
    const y = Math.round((height * j) / ROWS) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  // the centre cross, with five small ticks to a division
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  const cx = Math.round(width / 2) + 0.5;
  const cy = Math.round(height / 2) + 0.5;
  ctx.moveTo(0, cy);
  ctx.lineTo(width, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, height);
  for (let t = 0; t <= COLS * 5; t++) {
    const x = Math.round((width * t) / (COLS * 5)) + 0.5;
    ctx.moveTo(x, cy - (t % 5 === 0 ? 4 : 2));
    ctx.lineTo(x, cy + (t % 5 === 0 ? 4 : 2));
  }
  for (let t = 0; t <= ROWS * 5; t++) {
    const y = Math.round((height * t) / (ROWS * 5)) + 0.5;
    ctx.moveTo(cx - (t % 5 === 0 ? 4 : 2), y);
    ctx.lineTo(cx + (t % 5 === 0 ? 4 : 2), y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // the glass: dark corners, a glare high on the left, and a fine grain
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.35,
    width / 2,
    height / 2,
    Math.hypot(width, height) * 0.58,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.5)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  const glare = ctx.createLinearGradient(0, 0, width * 0.7, height * 0.9);
  glare.addColorStop(0, "rgba(220, 255, 235, 0.07)");
  glare.addColorStop(0.35, "rgba(220, 255, 235, 0)");
  ctx.fillStyle = glare;
  ctx.fillRect(0, 0, width, height);
  const pattern = ctx.createPattern(grain(96), "repeat");
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  }
  // the readout, in the house mono
  ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(93, 255, 156, 0.62)";
  ctx.fillText(axes, 10, height - 8);
  ctx.textBaseline = "top";
  ctx.fillText("x-y", 10, 8);
}
