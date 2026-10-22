// TEST SUPPORT, NOT PART OF THE PRODUCT. A pure TypeScript implementation of the renderer contract
// (ARCHITECTURE.md, "Determinism contract"), written from the contract text. It exists only as a
// cross-check against the same vectors as the .wasm, and as the agreed exit if the .wasm route fails.
// It is not imported by web/ and never reaches the UI bundle.
//
// Every intermediate value stays below 2^53, so plain numbers are exact; floor division by a power
// of two stands in for an arithmetic shift.

export const MAX_INPUT_FRAMES = 2 ** 21;
export const MAX_TERM = 2 ** 20;
export const MAX_FADE = 240;
export const E_PARAM = -1;
export const E_CAP = -2;

const shr = (x: number, bits: number): number => Math.floor(x / 2 ** bits);

export function outLen(inLen: number, p: number, q: number): number {
  if (inLen < 1 || inLen > MAX_INPUT_FRAMES) return E_PARAM;
  if (p < 1 || q < 1 || p > MAX_TERM || q > MAX_TERM) return E_PARAM;
  if (p > 4 * q || 4 * p < q) return E_PARAM;
  return Math.floor(((inLen - 1) * q) / p) + 1;
}

/** Return code of a render call: frames, or a negative status. Parameters, then method, then capacity. */
export function status(
  inLen: number,
  p: number,
  q: number,
  method: number,
  outCap: number,
): number {
  const n = outLen(inLen, p, q);
  if (n < 0) return n;
  if (method !== 0 && method !== 1) return E_PARAM;
  if (n > outCap) return E_CAP;
  return n;
}

export function render(src: Int16Array, p: number, q: number, method: number): Int16Array {
  const n = outLen(src.length, p, q);
  if (n < 1 || (method !== 0 && method !== 1))
    throw new RangeError("render called outside the contract");
  const out = new Int16Array(n);
  const at = (i: number): number => (i >= 0 && i < src.length ? (src[i] as number) : 0);
  const fade = Math.min(MAX_FADE, Math.floor(n / 2));
  for (let k = 0; k < n; k++) {
    const position = k * p;
    const index = Math.floor(position / q);
    const t = Math.floor(((position - index * q) * 32768) / q); // Q15
    let y: number;
    if (method === 0) {
      y = shr(at(index) * (32768 - t) + at(index + 1) * t + 16384, 15);
    } else {
      const t2 = t * t;
      const t3 = t2 * t;
      const a = t2 * 32768;
      const b = t * 2 ** 30;
      const one = 2 ** 45;
      const wPrev = shr(-t3 + 2 * a - b, 16);
      const wHere = shr(3 * t3 - 5 * a + 2 * one, 16);
      const wNext = shr(-3 * t3 + 4 * a + b, 16);
      const wAfter = shr(t3 - a, 16);
      const acc =
        at(index - 1) * wPrev + at(index) * wHere + at(index + 1) * wNext + at(index + 2) * wAfter;
      y = shr(acc + 2 ** 29, 30);
    }
    const d = Math.min(k, n - 1 - k);
    if (d < fade) y = shr(y * Math.floor((d * 32768) / fade) + 16384, 15);
    out[k] = Math.max(-32768, Math.min(32767, y));
  }
  return out;
}
