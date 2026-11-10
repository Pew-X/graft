// Types for fixtures/vectors/vectors.json, its input generators, and the two ingest canonicalisation
// rules. TypeScript is where the canonicalisation rules run in production, so they are checked here.

export type Input =
  | { kind: "lcg"; len: number; seed: number }
  | { kind: "square"; len: number; half_period_log2: number }
  | { kind: "constant"; len: number; value: number }
  | { kind: "literal"; samples: number[] };

export interface Vector {
  name: string;
  doc: string;
  input: Input;
  p: number;
  q: number;
  method: number;
  out_cap: number;
  expect: { status: number; sha256?: string; samples?: number[] };
}

export interface PointerExpect {
  case: string;
  expect: string;
}

export type Scenario =
  | { kind: "repeat"; name: string; vector: string; times: number }
  | { kind: "growth"; name: string; big: string; times: number; then: string }
  | {
      kind: "pointers";
      name: string;
      in_len: number;
      p: number;
      q: number;
      method: number;
      cases: PointerExpect[];
    };

export interface Table {
  schema: number;
  renderer: { name: string; version: number };
  vectors: Vector[];
  out_len: { in_len: number; p: number; q: number; expect: number }[];
  canonicalisation: {
    f32_to_s16: { cases: { name: string; bits: number; expect: number }[] };
    downmix: { cases: { left: number; right: number; expect: number }[] };
  };
  scenarios: Scenario[];
}

export function generate(input: Input): Int16Array {
  if (input.kind === "literal") return Int16Array.from(input.samples);
  const out = new Int16Array(input.len);
  if (input.kind === "lcg") {
    let state = input.seed >>> 0;
    for (let i = 0; i < input.len; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const v = state >>> 16;
      out[i] = v >= 32768 ? v - 65536 : v;
    }
  } else if (input.kind === "square") {
    for (let i = 0; i < input.len; i++) {
      out[i] = (i >> input.half_period_log2) & 1 ? 32767 : -32768;
    }
  } else {
    out.fill(input.value);
  }
  return out;
}

/** Float sample (given as raw f32 bits) to signed 16-bit: scale by 32768, add one half, floor, clamp; NaN is 0. */
export function f32BitsToS16(bits: number): number {
  const f = new Float32Array(1);
  new Uint32Array(f.buffer)[0] = bits >>> 0;
  const x = f[0] as number;
  if (Number.isNaN(x)) return 0;
  return Math.max(-32768, Math.min(32767, Math.floor(x * 32768 + 0.5)));
}

/** Stereo to mono on signed 16-bit values: (left + right + 1) >> 1, arithmetic shift. */
export function downmix(left: number, right: number): number {
  return (left + right + 1) >> 1;
}
