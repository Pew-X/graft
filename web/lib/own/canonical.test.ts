// Canonicalisation of a recording: the two named rules, checked against the committed vectors (the
// same file the Rust and the other-language checks read), then the whole step on small sounds whose
// canonical bytes are worked out by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalise, downmix, f32ToS16, MAX_CHANNELS } from "./canonical.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../../../fixtures/vectors/vectors.json", import.meta.url), "utf8"),
) as {
  canonicalisation: {
    f32_to_s16: { cases: Array<{ name: string; bits: number; expect: number }> };
    downmix: { cases: Array<{ left: number; right: number; expect: number }> };
  };
};

function fromBits(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  return view.getFloat32(0);
}

test("float to 16-bit follows every committed vector, ties and infinities and NaN included", () => {
  for (const c of vectors.canonicalisation.f32_to_s16.cases) {
    assert.equal(f32ToS16(fromBits(c.bits)), c.expect, c.name);
  }
});

test("the stereo downmix follows every committed vector", () => {
  for (const c of vectors.canonicalisation.downmix.cases) {
    assert.equal(downmix(c.left, c.right), c.expect, `${c.left} and ${c.right}`);
  }
});

test("a mono sound is each sample rounded once: values over 32768 come back exactly", () => {
  const ints = Int16Array.of(0, 1, -1, 12_345, -12_345, 32_767, -32_768);
  const floats = Float32Array.from(ints, (v) => v / 32_768);
  assert.deepEqual([...canonicalise([floats])], [...ints]);
});

test("a stereo sound is downmixed on the 16-bit values, after each channel is rounded", () => {
  const left = Float32Array.from([1, 3, -1, 32_767], (v) => v / 32_768);
  const right = Float32Array.from([2, 0, -2, 32_766], (v) => v / 32_768);
  // (1+2+1)>>1 = 2, (3+0+1)>>1 = 2, (-1-2+1)>>1 = -1, (32767+32766+1)>>1 = 32767
  assert.deepEqual([...canonicalise([left, right])], [2, 2, -1, 32_767]);
});

test("a channel longer or shorter than the first is read as far as both go, never past an end", () => {
  const a = new Float32Array(10).fill(0.5);
  const b = new Float32Array(6).fill(0.25);
  assert.equal(canonicalise([a, b]).length, 6);
});

test("more than two channels are refused rather than guessed at", () => {
  assert.equal(MAX_CHANNELS, 2);
  assert.throws(
    () => canonicalise([new Float32Array(1), new Float32Array(1), new Float32Array(1)]),
    /channels/,
  );
  assert.throws(() => canonicalise([]), /no channels/);
});

test("the same input twice gives the same bytes", () => {
  const x = Float32Array.from({ length: 1_000 }, (_, i) => Math.sin(i / 7) * 0.8);
  assert.deepEqual([...canonicalise([x])], [...canonicalise([x])]);
});
