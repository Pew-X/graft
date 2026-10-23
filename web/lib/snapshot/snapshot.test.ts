// The static snapshot the roll opens on: the data and the audio exist, are what they say they are,
// and are served so that they can be cached for ever. Whether the snapshot still matches a freshly
// seeded database is checked by the Rust suite (crates/api/tests/chain/seeded.rs); this checks what
// the web app ships.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import config from "../../next.config.ts";

const web = join(import.meta.dirname, "..", "..");
const seedDir = join(web, "public", "seed");

interface Stage {
  id: string;
  kind: string;
  parent_id: string | null;
  source_blob: string;
  output_blob: string;
  frames: number;
  audio_path: string;
  [field: string]: unknown;
}
interface Snapshot {
  version: number;
  stages: Stage[];
}

const snapshot = JSON.parse(readFileSync(join(web, "snapshot", "chain.json"), "utf8")) as Snapshot;
// The curated sources ship beside the chain: the same format, every stage a source, audio in the same folder.
const sources = JSON.parse(readFileSync(join(web, "snapshot", "sources.json"), "utf8")) as Snapshot;

test("the snapshot is a chain: a source, then each stage built on the one before", () => {
  assert.equal(snapshot.version, 1);
  assert.ok(snapshot.stages.length >= 2);
  const [source, ...flips] = snapshot.stages;
  assert.equal(source?.kind, "source");
  assert.equal(source?.parent_id, null);
  let previous = source!;
  for (const stage of flips) {
    assert.equal(stage.kind, "flip");
    assert.equal(stage.parent_id, previous.id, `${stage.id} names the stage before it`);
    assert.equal(
      stage.source_blob,
      previous.output_blob,
      `${stage.id} was cut from that stage's audio`,
    );
    previous = stage;
  }
});

test("every stage's audio is a static file named by the SHA-256 of its bytes, and nothing else is there", () => {
  const referenced = new Set<string>();
  for (const stage of [...snapshot.stages, ...sources.stages]) {
    const match = /^\/seed\/([0-9a-f]{64})\.pcm$/.exec(stage.audio_path);
    assert.ok(match, `${stage.audio_path} is a content-hashed path`);
    const name = match[1]!;
    assert.equal(name, stage.output_blob, "the file is named for the stage's output hash");
    const bytes = readFileSync(join(seedDir, `${name}.pcm`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      name,
      "and its bytes hash to the name",
    );
    assert.equal(bytes.length, stage.frames * 2, "16-bit mono: two bytes a frame");
    referenced.add(`${name}.pcm`);
  }
  assert.deepEqual(readdirSync(seedDir).sort(), [...referenced].sort());
});

test("the audio is served with a cache lifetime of a year and marked immutable", async () => {
  const rules = await config.headers!();
  const rule = rules.find((r) => r.source === "/seed/:path*");
  assert.ok(rule, "a header rule covers /seed");
  const cache = rule.headers.find((h) => h.key.toLowerCase() === "cache-control");
  assert.equal(cache?.value, "public, max-age=31536000, immutable");
  // A file whose name is its hash can never change, so no other path gets a long cache lifetime.
  const long = rules.filter((r) =>
    r.headers.some((h) => h.key.toLowerCase() === "cache-control" && /immutable/.test(h.value)),
  );
  assert.deepEqual(
    long.map((r) => r.source),
    ["/seed/:path*"],
  );
});

test("the operator's page is kept out of search engines and archives", async () => {
  const rule = (await config.headers!()).find((r) => r.source === "/admin");
  assert.ok(rule, "a header rule covers /admin");
  const robots = rule.headers.find((h) => h.key.toLowerCase() === "x-robots-tag");
  assert.match(robots?.value ?? "", /noindex/);
  assert.match(robots?.value ?? "", /nofollow/);
  assert.match(robots?.value ?? "", /noarchive/);
});

test("the snapshot names only public ids, hashes and computed facts, never a key or a signed address", () => {
  const text = readFileSync(join(web, "snapshot", "chain.json"), "utf8");
  for (const word of ["manage", "secret", "admin", "key", "created", "expires", "http"]) {
    assert.ok(!text.includes(word), `${word} appears in the snapshot`);
  }
  const allowed = [
    "audio_path",
    "author",
    "cut_end",
    "cut_start",
    "frames",
    "id",
    "kind",
    "lines",
    "output_blob",
    "parent_id",
    "record_id",
    "renderer",
    "renderer_wasm_sha256",
    "source_blob",
    "speed_p",
    "speed_q",
    "title",
  ];
  for (const stage of snapshot.stages) {
    assert.deepEqual(Object.keys(stage).sort(), allowed);
  }
});
