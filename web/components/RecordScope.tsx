"use client";

import { useEffect, useRef } from "react";
import { FrameGovernor } from "../lib/record/frames.ts";
import {
  beamLevel,
  delayPairs,
  delaySamples,
  gainFor,
  nextReference,
  slewDelay,
  tunedDelay,
} from "../lib/own/scope.ts";

/** The house screen and beam (the trace tile's own values): always dark, as a real one is, in both themes. */
const SCREEN = "#070908";
const BEAM = "#5dff9c";
/** Where the beam is brightest it runs white-hot, as a phosphor does where it is hit hardest. */
const HOT = "#d9ffe8";
/** How much of the last frame the next one leaves lit: the afterglow, a few tenths of a second. */
const FADE = 0.075;
const FFT = 2048;
/** The screen is eight by six divisions of a 4:3 tube; the picture keeps to the middle of it. */
const COLS = 8;
const ROWS = 6;
/** The loops that carry a voice are low; above this the beam only jitters, so it is not followed. */
const CEILING_HZ = 1500;

interface Tap {
  context: AudioContext;
  analyser: AnalyserNode;
}

/** The microphone's stream into one analyser, between a high-pass for rumble and a low-pass for jitter. Never connected to the speakers. */
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
  const jitter = context.createBiquadFilter();
  jitter.type = "lowpass";
  jitter.frequency.value = CEILING_HZ;
  jitter.Q.value = 0.7;
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT;
  analyser.smoothingTimeConstant = 0;
  source.connect(rumble);
  rumble.connect(jitter);
  jitter.connect(analyser);
  return { context, analyser };
}

/** The newest samples as floats; a browser without the float call (older Safari) gives bytes, made into floats. */
function read(
  analyser: AnalyserNode,
  into: Float32Array<ArrayBuffer>,
  bytes: Uint8Array<ArrayBuffer>,
): void {
  if (typeof analyser.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(into);
    return;
  }
  analyser.getByteTimeDomainData(bytes);
  for (let i = 0; i < bytes.length; i++) into[i] = ((bytes[i] ?? 128) - 128) / 128;
}

/**
 * The recording scope: an oscilloscope in X-Y mode, the glowing loops of a vintage tape machine on a tube.
 * The sound drives both axes: x is the microphone now, y is the microphone a moment earlier, and that
 * moment follows the sound (the first zero of its autocorrelation, a quarter of a tone's period), so a
 * steady tone is a circle, a voice a figure that turns as the pitch does, and the size follows the
 * loudness against what is usual for the sound. The beam leaves an afterglow, runs dimmer where it moves
 * fast and white-hot where it lingers or crosses itself, and the glass round it glows with the sound. It
 * draws only what the sound is: silence is a dot. There is no writing on it, as there is none on a tube.
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
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const governor = new FrameGovernor();
    const data = new Float32Array(FFT);
    const bytes = new Uint8Array(FFT);
    let delay = delaySamples(rate);
    let reference = 0.05;
    let glow = 0;
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
        glass(s, width, height);
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
      read(analyser, data, bytes);
      // the delay follows the sound, looked for every third frame and glided to
      if (frames % 3 === 0) {
        const found = tunedDelay(data, rate);
        if (found !== null) delay = slewDelay(delay, Math.round(found));
      }
      const count = Math.min(FFT, Math.round((since / 1000) * rate) + delay + 8);
      const fresh = data.subarray(FFT - count);
      let peak = 0;
      for (const v of fresh) peak = Math.max(peak, Math.abs(v));
      reference = nextReference(reference, peak);
      const gain = gainFor(reference);
      const pairs = delayPairs(fresh, delay, gain);
      // how big the figure is this frame, 0 to 1: the glass glows with it, and fades when the sound does
      const reach = Math.min(1, peak * gain);
      glow = reach > glow ? glow + (reach - glow) * 0.35 : glow * 0.96;

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
      if (pairs.length <= 1 || peak < 0.002) {
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
      // the bloom: a small copy of the picture, which the page blurs and lays over it, lights the glass
      // round the figure; the louder the sound, the more of it
      const bctx = bloomEl.getContext("2d");
      if (bctx) {
        bctx.globalCompositeOperation = "copy";
        bctx.drawImage(beamEl, 0, 0, bloomEl.width, bloomEl.height);
      }
      box.style.setProperty("--glow", glow.toFixed(3));
      box.dataset["frames"] = String(frames);
      box.dataset["delay"] = String(delay);
      box.dataset["rate"] = String(rate);
      box.dataset["peak"] = peak.toFixed(4);
      box.dataset["reference"] = reference.toFixed(4);
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
 * The sheet in front of the tube: a graticule so faint it is felt more than seen, a tube that is lit
 * from within (a green haze that is brightest in the middle), the glass (a dark vignette at the corners, a
 * soft glare, a fine grain). No axes and no words: a tube has none.
 */
function glass(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  // the tube lit from within
  const lit = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.hypot(width, height) * 0.56,
  );
  // eased in many small steps, so no edge can be seen: a haze, not a plate
  for (const [at, alpha] of [
    [0, 0.1],
    [0.2, 0.085],
    [0.4, 0.056],
    [0.6, 0.03],
    [0.8, 0.011],
    [1, 0],
  ] as const)
    lit.addColorStop(at, `rgba(40, 150, 95, ${alpha})`);
  ctx.fillStyle = lit;
  ctx.fillRect(0, 0, width, height);
  // the graticule, faint
  ctx.strokeStyle = BEAM;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.055;
  ctx.beginPath();
  for (let i = 1; i < COLS; i++) {
    const x = Math.round((width * i) / COLS) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let j = 1; j < ROWS; j++) {
    const y = Math.round((height * j) / ROWS) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // the glass: dark corners, a glare high on the left, and a fine grain
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.hypot(width, height) * 0.58,
  );
  // darkness grows with the square of the distance from the middle, in small steps: no radius at which it
  // begins, so no disc can be seen inside it
  for (let step = 0; step <= 8; step++) {
    const t = step / 8;
    vignette.addColorStop(t, `rgba(0, 0, 0, ${(0.55 * t * t * t).toFixed(3)})`);
  }
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
}
