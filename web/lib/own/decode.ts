/**
 * From a recording's bytes to canonical audio, in the browser: decode in an offline audio context at
 * 48 kHz (so the browser resamples), then the two rules in canonical.ts. The sound stays in memory;
 * nothing here sends anything anywhere.
 */
import { canonicalise, MAX_CHANNELS } from "./canonical.ts";

/** Larger files are refused before they are read into memory. */
export const MAX_FILE_BYTES = 30_000_000;
/** The longest recording that can be trimmed down to a source: two minutes. */
export const MAX_DECODED_FRAMES = 120 * 48_000;

export type Decoded =
  | { ok: true; samples: Int16Array }
  | { ok: false; reason: "tooBig" | "unreadable" | "tooLongToTrim" | "channels" | "empty" };

export async function decodeToCanonical(data: ArrayBuffer): Promise<Decoded> {
  if (data.byteLength > MAX_FILE_BYTES) return { ok: false, reason: "tooBig" };
  if (data.byteLength === 0) return { ok: false, reason: "empty" };
  let buffer: AudioBuffer;
  try {
    // One frame, one channel, 48 kHz: only the rate matters, the decoder keeps the file's channels.
    buffer = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(data);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (buffer.length === 0) return { ok: false, reason: "empty" };
  if (buffer.length > MAX_DECODED_FRAMES) return { ok: false, reason: "tooLongToTrim" };
  if (buffer.numberOfChannels > MAX_CHANNELS) return { ok: false, reason: "channels" };
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  );
  return { ok: true, samples: canonicalise(channels) };
}
