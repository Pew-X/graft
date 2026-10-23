/**
 * Canonical audio from a decoded recording: 48 kHz mono signed 16-bit. The decoder (an offline
 * audio context at 48 kHz) hands over floats per channel; the two rules here are the only
 * arithmetic, and both are fixed by the committed vectors (`canonicalisation` in
 * fixtures/vectors/vectors.json):
 *   - float to 16-bit: scale by 32768, add one half, floor, clamp to [-32768, 32767]; NaN is 0;
 *   - stereo to mono, on the 16-bit values: (left + right + 1) >> 1.
 * A compressed file may decode to slightly different floats in different browsers, so the guarantee
 * begins at the bytes this returns, not at the file.
 */
export const MAX_CHANNELS = 2;

export function f32ToS16(x: number): number {
  if (Number.isNaN(x)) return 0;
  const scaled = Math.floor(x * 32_768 + 0.5);
  return scaled > 32_767 ? 32_767 : scaled < -32_768 ? -32_768 : scaled;
}

export function downmix(left: number, right: number): number {
  return (left + right + 1) >> 1;
}

export function canonicalise(channels: readonly Float32Array[]): Int16Array {
  const first = channels[0];
  if (first === undefined) throw new RangeError("the recording has no channels");
  if (channels.length > MAX_CHANNELS) {
    throw new RangeError(`the recording has ${channels.length} channels; at most two are read`);
  }
  const second = channels[1];
  const length = second === undefined ? first.length : Math.min(first.length, second.length);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const l = f32ToS16(first[i] ?? 0);
    out[i] = second === undefined ? l : downmix(l, f32ToS16(second[i] ?? 0));
  }
  return out;
}
