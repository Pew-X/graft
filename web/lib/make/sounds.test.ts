import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { soundsFrom, type Shipped } from "./sounds.ts";

const web = new URL("../../", import.meta.url);
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`snapshot/${name}.json`, web), "utf8")) as Shipped;
const chain = read("chain");
const sources = read("sources");

test("the curated sources come first, each with its declared licence line carried as typed", () => {
  const { curated } = soundsFrom(chain, sources);
  assert.equal(curated.length, 10);
  for (const s of curated) {
    assert.equal(s.licence?.value, "own work, synthesized for graft");
    assert.equal(s.licence?.honesty, "declared", "said, not checked");
    assert.match(s.audioPath, /^\/seed\/[0-9a-f]{64}\.pcm$/);
    assert.ok(s.frames >= 480);
  }
});

test("the home chain's flips are offered too, but its source is not listed twice", () => {
  const { curated, flips } = soundsFrom(chain, sources);
  assert.equal(flips.length, 3);
  const ids = new Set([...curated, ...flips].map((s) => s.id));
  assert.equal(ids.size, 13, "ten sources and three flips, no id twice");
  assert.ok(
    curated.some((s) => s.id === chain.stages[0]?.id),
    "the chain's source is a curated one",
  );
});

test("a sound is found by its public id, from either list", () => {
  const all = soundsFrom(chain, sources);
  const flip = chain.stages[2]!;
  assert.equal(all.find(flip.id)?.title, flip.title);
  assert.equal(all.find(sources.stages[4]!.id)?.title, sources.stages[4]!.title);
  assert.equal(all.find("nonesuch"), undefined);
});

test("a flip is described by its cut and speed in plain words, never a licence it does not have", () => {
  const { flips } = soundsFrom(chain, sources);
  assert.equal(flips[0]?.licence, null);
  assert.ok(flips.every((f) => f.kind === "flip"));
});
