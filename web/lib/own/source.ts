/** The body of a source published from the maker's own recording. */
import type { PublishSourceBody } from "../publish/client.ts";
import { type Cut, LIMITS, type Problem } from "../make/cut.ts";

/** The statement the service requires, word for word; a test compares it with the service's. */
export const DECLARATION_TEXT =
  "I made this sound or I have the right to share it. It does not contain anyone's private conversation.";

/** The longest source: 15 seconds. */
export const MAX_FRAMES = 720_000;

export type Basis = "own_recording" | "right_to_share";

/** Standard base64 of canonical bytes (little-endian 16-bit), built in chunks so it never overruns the call limit. */
export function toBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function sourceBody(input: {
  samples: Int16Array;
  title: string;
  author: string;
  retryKey: string;
  basis: Basis;
}): PublishSourceBody {
  return {
    audio: toBase64(input.samples),
    title: input.title,
    author: input.author,
    retry_key: input.retryKey,
    declaration: { statement: DECLARATION_TEXT, basis: input.basis },
  };
}

/** The part of a long recording to keep: whole frames inside the sound, 480 frames to 15 seconds. */
export function checkTrim(cut: Cut, frames: number): Problem | null {
  const { start, end } = cut;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > frames) {
    return { kind: "cutOutside" };
  }
  if (end <= start) return { kind: "cutInverted" };
  if (end - start < LIMITS.minFrames) return { kind: "cutShort" };
  return end - start > MAX_FRAMES ? { kind: "cutLong" } : null;
}
