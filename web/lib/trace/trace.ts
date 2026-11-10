/**
 * A flip's trace: a line drawn on an oscilloscope screen from the flip's public id. The same id always
 * draws the same line and different ids draw different ones, so a maker can recognise their own flip at
 * a glance and tell two apart. It is a picture, not a measurement: it is not drawn from the audio, and it
 * says nothing about the sound. The id is public already, so nothing secret is ever drawn from.
 */

/** A small string hash (FNV-1a) turned into a 32-bit seed. Not for security: the input is public. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `points` values between -1 and 1: three sines of seeded frequency and phase under an envelope that
 * swells and falls, as a struck sound does, so every trace has a beginning and an end at rest.
 */
export function traceOf(id: string, points = 120): number[] {
  const rand = seeded(seedOf(id));
  const waves = [0, 1, 2].map((i) => ({
    freq: 4 + Math.floor(rand() * (8 + i * 6)),
    phase: rand() * Math.PI * 2,
    weight: (0.5 + rand() * 0.5) / (i + 1),
  }));
  const peak = 0.25 + rand() * 0.5;
  const total = waves.reduce((sum, w) => sum + w.weight, 0);
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 0 : i / (points - 1);
    const envelope = Math.sin(Math.PI * Math.pow(t, 0.55 + peak * 0.5));
    let v = 0;
    for (const w of waves) v += w.weight * Math.sin(w.freq * Math.PI * 2 * t + w.phase);
    out.push(Math.max(-1, Math.min(1, (v / total) * envelope)));
  }
  return out;
}

/** The values as an SVG path in a `width` by `height` box, the zero line in the middle. */
export function tracePath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const mid = height / 2;
  const amp = (height / 2) * 0.86;
  return values
    .map((v, i) => {
      const x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
      const y = mid - v * amp;
      return `${i === 0 ? "M" : "L"}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}
