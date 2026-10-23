// The view-model turns a chain's stages into credit blocks. These tests read the real snapshot the
// home page ships, and check hand-worked expectations against it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildBlocks, type StageInput } from "./view.ts";

const web = join(import.meta.dirname, "..", "..");
const snapshot = JSON.parse(readFileSync(join(web, "snapshot", "chain.json"), "utf8")) as {
  stages: StageInput[];
};
const blocks = buildBlocks(snapshot.stages);
const STATES = ["declared", "computed", "unknown"];

test("one block per stage, numbered from 1 in order, source first", () => {
  assert.equal(blocks.length, 4);
  assert.deepEqual(
    blocks.map((b) => b.numeral),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(
    blocks.map((b) => b.title),
    ["dm9 chord", "up a fifth", "down a fifth", "down an octave"],
  );
});

test("every line, on the face and in the details, says its honesty state in words", () => {
  for (const block of blocks) {
    for (const row of [...block.face, ...block.details]) {
      assert.ok(STATES.includes(row.honesty), `${block.title}: ${row.honesty}`);
      assert.equal(
        row.state,
        row.honesty,
        "the word is the state itself, not a colour or a symbol",
      );
    }
  }
});

test("a declared name is marked as typed; a computed value never is", () => {
  const flip = blocks[1]!;
  const by = flip.face.find((l) => l.role === "flipped by")!;
  assert.equal(by.asTyped, true);
  for (const row of flip.details.filter((r) => r.honesty === "computed")) {
    assert.equal(row.asTyped, false, row.label);
  }
});

test("the details layer gives the exact values of the second stage", () => {
  const rows = Object.fromEntries(blocks[1]!.details.map((r) => [r.label, r.value]));
  assert.equal(rows["the cut"], "frames 0 to 43200");
  assert.equal(rows["speed"], "3/2 · 150% · a fifth up");
  assert.equal(rows["length"], "0.6 s"); // 28800 frames at 48 kHz
  assert.equal(rows["renderer"], "graft-render 1");
  assert.equal(rows["stage id"], "q0yjjgng394w");
  assert.match(rows["audio hash (sha-256)"]!, /^[0-9a-f]{64}$/);
});

test("a source has no speed row and says so by leaving it out", () => {
  assert.equal(
    blocks[0]!.details.some((r) => r.label === "speed"),
    false,
  );
});

test("what the details derive from the numbers agrees with the credit lines the server wrote", () => {
  for (const [i, stage] of snapshot.stages.entries()) {
    const cut = stage.lines.find((l) => l.role === "cut");
    if (cut) assert.equal(blocks[i]!.details.find((r) => r.label === "the cut")?.value, cut.value);
    const speed = stage.lines.find((l) => l.role === "speed");
    if (speed) {
      const shown = blocks[i]!.details.find((r) => r.label === "speed")!.value;
      assert.ok(shown.startsWith(`${speed.value} · `), `${shown} begins with ${speed.value}`);
    }
  }
});

test("dyes cycle through four by stage index", () => {
  const long = buildBlocks(
    Array.from({ length: 6 }, (_, i) => ({ ...snapshot.stages[1]!, id: `s${i}` })),
  );
  assert.deepEqual(
    long.map((b) => b.dye),
    [0, 1, 2, 3, 0, 1],
  );
});

test("a stage whose audio is not served carries no audio path", () => {
  const held = buildBlocks([{ ...snapshot.stages[0]!, audio_path: null }]);
  assert.equal(held[0]!.audioPath, null);
});
