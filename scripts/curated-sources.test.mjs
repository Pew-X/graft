import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NAMES, makeAll } from "./curated-sources.mjs";

const manifest = JSON.parse(readFileSync(new URL("../seed/sources.json", import.meta.url), "utf8"));
const chain = JSON.parse(readFileSync(new URL("../seed/chain.json", import.meta.url), "utf8"));
const file = (rel) => readFileSync(new URL(`../seed/${rel}`, import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the committed files are exactly what the generator makes, so the set can be remade from the repository", () => {
  for (const [name, bytes] of makeAll()) {
    assert.ok(bytes.equals(file(`sources/${name}.pcm`)), `${name}.pcm differs from the generator`);
  }
});

test("every file is canonical audio: whole 16-bit samples, within the 15 second source cap", () => {
  for (const [name, bytes] of makeAll()) {
    assert.equal(bytes.length % 2, 0, name);
    const frames = bytes.length / 2;
    assert.ok(frames >= 480 && frames <= 15 * 48000, `${name}: ${frames} frames`);
  }
});

test("no sound is silent or clipped flat: each has a real peak below full scale", () => {
  for (const [name, bytes] of makeAll()) {
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 3000 && peak < 32767, `${name}: peak ${peak}`);
  }
});

test("the manifest lists every generated sound once, in order, with the hash of its file", () => {
  assert.deepEqual(manifest.sources.map((s) => s.audio_file), NAMES.map((n) => `sources/${n}.pcm`));
  for (const s of manifest.sources) assert.equal(s.audio_sha256, sha(file(s.audio_file)), s.key);
});

test("each source declares its evidence as typed: own work, with a title and an author", () => {
  for (const s of manifest.sources) {
    assert.equal(s.licence, "own work, synthesized for graft", s.key);
    assert.ok(s.title && s.author, s.key);
    assert.ok(s.title.length <= 60 && s.author.length <= 32, s.key);
  }
  assert.equal(new Set(manifest.sources.map((s) => s.key)).size, manifest.sources.length);
});

test("the seeded chain starts from one of the curated sources, the same file and key, not a copy", () => {
  const same = manifest.sources.find((s) => s.key === chain.source.key);
  assert.ok(same, "the chain's source key is in the curated set");
  for (const field of ["title", "author", "audio_file", "audio_sha256", "licence", "work_title", "work_author"]) {
    assert.equal(same[field], chain.source[field], field);
  }
});

test("the words the repository keeps out of its text are not in the set's titles or descriptions", () => {
  const banned = /\b(drop|stack|take|recipe|kitchen|chef|verified|proven|certified|owned by|cleared)\b/i;
  for (const s of manifest.sources) assert.doesNotMatch(`${s.title} ${s.work_title}`, banned, s.key);
});
