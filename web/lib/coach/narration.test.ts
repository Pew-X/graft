// The captions of the first play are worked out from the chain's own data. Each expected string below
// is written by hand from the chain it describes, so a change to the wording shows up here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSteps } from "../playback/steps.ts";
import { buildBlocks, type StageInput } from "../roll/view.ts";
import { captions, momentAt, shorten, type Narrated } from "./narration.ts";

const source = (title = "dm9 chord"): Narrated => ({
  kind: "source",
  title,
  state: "available",
  cutFrames: null,
  speed: null,
});
const flip = (
  cut: [number, number],
  speed: { p: number; q: number } | null,
  state: Narrated["state"] = "available",
): Narrated => ({ kind: "flip", title: "a flip", state, cutFrames: cut, speed });

/** Every caption of a chain, in the order the roll plays: teaser, each stage from the source, rest. */
const all = (stages: Narrated[], frames: Array<number | null> = stages.map(() => 57_600)) =>
  buildSteps(stages.length).map((step) => captions(step, stages, frames));

test("the four moments of the seeded chain, in the order the sound plays", () => {
  const web = join(import.meta.dirname, "..", "..");
  const snapshot = JSON.parse(readFileSync(join(web, "snapshot", "chain.json"), "utf8")) as {
    stages: StageInput[];
  };
  const stages = buildBlocks(snapshot.stages);
  // lengths of each stage's audio in frames, from the snapshot
  const frames = snapshot.stages.map((s) => s.frames);
  assert.deepEqual(
    buildSteps(stages.length).map((step) => captions(step, stages, frames)),
    [
      "this is the finished sound.",
      "it began as “dm9 chord”.",
      // 0 to 43200 of the 57600 frames before it, at 3/2
      "then a piece was cut out and sped up.",
      // 960 to 24000 of the 28800 before it, at 2/3
      "then a piece was cut out and slowed down.",
      // 4800 to 33600 of the 34559 before it, at 1/2
      "then a piece was cut out and slowed down.",
      "that is how it was made. tap any ring to hear that step.",
    ],
  );
});

test("faster, slower, the same speed and no speed, each for a piece of the sound before it", () => {
  const stages = [
    source(),
    flip([0, 100], { p: 3, q: 2 }),
    flip([0, 100], { p: 2, q: 3 }),
    flip([0, 100], { p: 1, q: 1 }),
    flip([0, 100], null),
  ];
  assert.deepEqual(all(stages).slice(2, 6), [
    "then a piece was cut out and sped up.",
    "then a piece was cut out and slowed down.",
    "then a piece was cut out and kept at the same speed.",
    "then a piece was cut out.",
  ]);
});

test("a cut that keeps the whole sound before it is not called a piece", () => {
  const stages = [source(), flip([0, 57_600], { p: 3, q: 2 }), flip([0, 57_700], { p: 2, q: 3 })];
  assert.deepEqual(all(stages).slice(2, 4), ["then it was sped up.", "then it was slowed down."]);
  const same = [source(), flip([0, 57_600], { p: 1, q: 1 })];
  assert.equal(all(same)[2], "then it was kept as it was.");
});

test("where the length before is not known yet, it is a piece rather than a claim of the whole", () => {
  const stages = [source(), flip([0, 57_600], { p: 3, q: 2 })];
  assert.equal(all(stages, [null, null])[2], "then a piece was cut out and sped up.");
});

test("no caption names a maker, whatever the chain's credits say", () => {
  const stages: Narrated[] = [source(), { ...flip([0, 100], { p: 3, q: 2 }), title: "up a fifth" }];
  // makers live in the credit lines, which captions never read: a person's name and "graft" alike
  for (const text of all(stages)) {
    assert.doesNotMatch(text, /\bby\b|graft|piyush|alice/i, text);
  }
});

test("the source's name is in quotes, with no article, and a long one is shortened", () => {
  assert.equal(all([source("808 sub"), flip([0, 1], null)])[1], "it began as “808 sub”.");
  const long = "a very long name that goes on and on past what a caption can hold";
  assert.equal(shorten(long), "a very long name that goes on a…");
  assert.equal(shorten("exactly thirty-two characters!!"), "exactly thirty-two characters!!");
  assert.equal(
    all([source(long), flip([0, 1], null)])[1],
    "it began as “a very long name that goes on a…”.",
  );
});

test("a step that is not here is said so, never narrated", () => {
  const stages = [
    source(),
    flip([0, 100], { p: 3, q: 2 }, "no_longer_here"),
    flip([0, 100], { p: 2, q: 3 }),
  ];
  assert.equal(all(stages)[2], "this step is no longer here. its credit stays.");
  const gone = [{ ...source(), state: "held" as const }, flip([0, 100], null)];
  assert.equal(all(gone)[1], "this step is no longer here. its credit stays.");
});

test("a chain of one stage, two stages and twelve all begin and end the same way", () => {
  const one = all([source()]);
  assert.deepEqual(one, [
    "this is the sound.",
    "it began as “dm9 chord”.",
    "that is all of it so far. tap the ring to hear it.",
  ]);
  const two = all([source(), flip([0, 100], { p: 3, q: 2 })]);
  assert.equal(two.length, 4);
  assert.equal(two[0], "this is the finished sound.");
  const twelve = all([
    source(),
    ...Array.from({ length: 11 }, () => flip([0, 100], { p: 3, q: 2 })),
  ]);
  assert.equal(twelve.length, 14);
  assert.equal(twelve.at(-1), "that is how it was made. tap any ring to hear that step.");
});

test("the moment follows the engine's step, and a paused roll keeps its caption", () => {
  assert.deepEqual(momentAt({ kind: "idle" }, 4), null);
  assert.deepEqual(momentAt({ kind: "rolling", step: 0, elapsed: 0 }, 4), {
    kind: "teaser",
    stage: 3,
  });
  assert.deepEqual(momentAt({ kind: "rolling", step: 2, elapsed: 1 }, 4), {
    kind: "stage",
    stage: 1,
  });
  assert.deepEqual(momentAt({ kind: "rolling", step: 5, elapsed: 9 }, 4), {
    kind: "rest",
    stage: 3,
  });
  assert.deepEqual(
    momentAt({ kind: "paused", from: { kind: "rolling", step: 1, elapsed: 0.5 } }, 4),
    { kind: "stage", stage: 0 },
  );
  assert.equal(momentAt({ kind: "auditioning", stage: 1, offset: 0, ended: false }, 4), null);
  assert.equal(momentAt({ kind: "rolling", step: 99, elapsed: 0 }, 4), null);
});
