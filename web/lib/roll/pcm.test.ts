import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePcm16le } from "./pcm.ts";

test("little-endian signed 16-bit samples, whatever the machine's own byte order", () => {
  // 0x0001 = 1, 0xffff = -1, 0x8000 = -32768, 0x7fff = 32767
  const bytes = new Uint8Array([0x01, 0x00, 0xff, 0xff, 0x00, 0x80, 0xff, 0x7f]);
  assert.deepEqual([...decodePcm16le(bytes.buffer)], [1, -1, -32768, 32767]);
});

test("an odd number of bytes is not audio and is refused", () => {
  assert.throws(() => decodePcm16le(new Uint8Array(3).buffer), RangeError);
});

test("an empty file is no samples", () => {
  assert.equal(decodePcm16le(new ArrayBuffer(0)).length, 0);
});
