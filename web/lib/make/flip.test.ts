// What the make flow hears and sends is what the service stores. The seeded chain's flips were made
// by the service (and checked against an independent reference renderer), so the browser's render of
// the same cut and speed must reproduce their audio, hash for hash.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodePcm16le } from "../roll/pcm.ts";
import { renderFlip } from "./flip.ts";
import { loadRenderer } from "./renderer.ts";

interface Stage {
  output_blob: string;
  cut_start: number;
  cut_end: number;
  speed_p: number | null;
  speed_q: number | null;
  frames: number;
}
const web = new URL("../../", import.meta.url);
const snapshot = JSON.parse(readFileSync(new URL("snapshot/chain.json", web), "utf8")) as {
  stages: Stage[];
};
const pcm = (hash: string) => {
  const b = readFileSync(new URL(`public/seed/${hash}.pcm`, web));
  return decodePcm16le(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const renderer = await loadRenderer(readFileSync(new URL("public/renderer/v1.wasm", web)));
const flips = snapshot.stages.slice(1);

test("the seeded chain has flips to compare with", () => {
  assert.equal(flips.length, 3);
});

test("each seeded flip, rendered in the browser's code from its parent, equals the service's audio", async () => {
  for (const [i, stage] of flips.entries()) {
    const parent = snapshot.stages[i]!;
    const made = await renderFlip(renderer, pcm(parent.output_blob), {
      cut: { start: stage.cut_start, end: stage.cut_end },
      p: stage.speed_p!,
      q: stage.speed_q!,
    });
    assert.ok(made.ok, `flip ${i + 1} was refused`);
    assert.equal(made.hash, stage.output_blob, `flip ${i + 1}`);
    assert.equal(made.samples.length, stage.frames);
  }
});

test("a cut that starts one frame late is a different sound: the parity check would catch an off-by-one", async () => {
  const stage = flips[0]!;
  const made = await renderFlip(renderer, pcm(snapshot.stages[0]!.output_blob), {
    cut: { start: stage.cut_start + 1, end: stage.cut_end },
    p: stage.speed_p!,
    q: stage.speed_q!,
  });
  assert.ok(made.ok);
  assert.notEqual(made.hash, stage.output_blob);
});

test("a cut that ends one frame early is also a different sound", async () => {
  const stage = flips[1]!;
  const made = await renderFlip(renderer, pcm(snapshot.stages[1]!.output_blob), {
    cut: { start: stage.cut_start, end: stage.cut_end - 1 },
    p: stage.speed_p!,
    q: stage.speed_q!,
  });
  assert.ok(made.ok);
  assert.notEqual(made.hash, stage.output_blob);
});

test("the first and last frames of every output are zero: a loop does not click", async () => {
  for (const [i, stage] of flips.entries()) {
    const made = await renderFlip(renderer, pcm(snapshot.stages[i]!.output_blob), {
      cut: { start: stage.cut_start, end: stage.cut_end },
      p: stage.speed_p!,
      q: stage.speed_q!,
    });
    assert.ok(made.ok);
    assert.equal(made.samples[0], 0);
    assert.equal(made.samples.at(-1), 0);
  }
});

test("a refused cut or speed is returned as the reason, and nothing is rendered", async () => {
  const source = pcm(snapshot.stages[0]!.output_blob);
  const short = await renderFlip(renderer, source, { cut: { start: 0, end: 100 }, p: 3, q: 2 });
  assert.deepEqual(short.ok ? null : short.problem.kind, "cutShort");
  const fast = await renderFlip(renderer, source, { cut: { start: 0, end: 10_000 }, p: 5, q: 1 });
  assert.deepEqual(fast.ok ? null : fast.problem.kind, "speedRange");
  const tiny = await renderFlip(renderer, source, { cut: { start: 0, end: 480 }, p: 4, q: 1 });
  assert.deepEqual(tiny.ok ? null : tiny.problem.kind, "outputShort");
});

test("the same cut and speed twice give identical bytes (a pure function of the cut)", async () => {
  const source = pcm(snapshot.stages[0]!.output_blob);
  const a = await renderFlip(renderer, source, { cut: { start: 960, end: 24_000 }, p: 2, q: 3 });
  const b = await renderFlip(renderer, source, { cut: { start: 960, end: 24_000 }, p: 2, q: 3 });
  assert.ok(a.ok && b.ok);
  assert.equal(a.hash, b.hash);
});
