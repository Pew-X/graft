// A chain read from the API becomes credit blocks. States are the point: a hidden stage keeps its
// credit and loses its audio, and nothing here carries a signed audio address (the server page must
// not leak one).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chain } from "../api/chain.ts";
import { blocksFromChain } from "./live.ts";

const line = (role: string, value: string, honesty: string) => ({ role, value, honesty });
const stage = (id: string, title: string, parent: string | null) => ({
  state: "available" as const,
  id,
  kind: parent ? "flip" : "source",
  title,
  author: "ana",
  created_at_ms: 1,
  flipped_count: 2,
  fork_permitted: true,
  parent_id: parent,
  lines: [
    line(parent ? "flip" : "source", title, "declared"),
    line("rights", "not established", "unknown"),
  ],
  details: {
    record_id: "r".repeat(64),
    source_blob: "a".repeat(64),
    output_blob: "b".repeat(64),
    cut: { start: 0, end: 43200 },
    renderer: { name: "graft-render", version: 1, wasm_sha256: "c".repeat(64) },
    speed: parent ? { p: 3, q: 2, method: 1 } : null,
  },
  audio: { url: "http://signed.example/a?sig=SECRET", expires_in_secs: 300 },
});
const removed = (state: "no_longer_here" | "held", id: string, title: string, parent: string) => ({
  state,
  id,
  kind: "flip",
  reason: state === "held" ? "rights" : "withdrawn",
  title,
  author: "bo",
  created_at_ms: 1,
  parent_id: parent,
  lines: [line("flip", title, "declared"), line("rights", "not established", "unknown")],
});

const chain: Chain = {
  stages: [
    stage("s0", "the source", null),
    removed("no_longer_here", "s1", "gone", "s0"),
    removed("held", "s2", "waiting", "s1"),
    { state: "unavailable", id: "s3" },
    stage("s4", "the last", "s3"),
  ],
  truncated: null,
} as Chain;
const blocks = blocksFromChain(chain);

test("every entry of the chain is a block, in order, with its state", () => {
  assert.deepEqual(
    blocks.map((b) => [b.numeral, b.title, b.state]),
    [
      ["1", "the source", "available"],
      ["2", "gone", "no_longer_here"],
      ["3", "waiting", "held"],
      ["4", "unavailable", "unavailable"],
      ["5", "the last", "available"],
    ],
  );
});

test("a hidden stage keeps its credit lines, says its state in words, and has no details or audio", () => {
  const gone = blocks[1]!;
  assert.deepEqual(
    gone.face.map((l) => [l.role, l.state]),
    [
      ["flip", "declared"],
      ["rights", "unknown"],
    ],
  );
  assert.equal(gone.details.length, 0);
  assert.equal(gone.audioPath, null);
});

test("no block carries an audio address, signed or not", () => {
  const text = JSON.stringify(blocks);
  assert.doesNotMatch(text, /signed\.example|SECRET|sig=|https?:/);
});

test("an available stage shows the exact values and how often it was flipped", () => {
  const last = blocks[4]!;
  const rows = Object.fromEntries(last.details.map((r) => [r.label, r.value]));
  assert.equal(rows["the cut"], "frames 0 to 43200");
  assert.equal(rows["speed"], "3/2 · 150% · a fifth up");
  assert.equal(rows["renderer"], "graft-render 1");
  assert.equal(rows["length"], undefined, "the length is not known until the audio is read");
  assert.equal(last.flipped, "flipped 2 times");
});

test("a stage nobody has flipped says so plainly", () => {
  const none = blocksFromChain({
    stages: [{ ...stage("s0", "x", null), flipped_count: 0 }],
    truncated: null,
  } as Chain);
  assert.equal(none[0]!.flipped, "not flipped yet");
  const once = blocksFromChain({
    stages: [{ ...stage("s0", "x", null), flipped_count: 1 }],
    truncated: null,
  } as Chain);
  assert.equal(once[0]!.flipped, "flipped once");
});
