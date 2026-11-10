// The make flow's hints: the order, the "once", and what a replay and a skip do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next, replayAt, type MakeEvent, type MakePhase } from "./make.ts";
import { COACH_KEY, COACH_VALUES, readMade, readPhase, writeMade, writePhase } from "./seen.ts";
import { SKETCH_GUIDE_KEY, startPhase, writeProgress } from "./sketch-guide.ts";

const run = (start: MakePhase, events: MakeEvent[], bank = true): MakePhase =>
  events.reduce<MakePhase>((phase, event) => next(phase, event, bank), start);

class Memory {
  items = new Map<string, string>();
  writes: string[] = [];
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(value);
    this.items.set(key, value);
  }
}

test("the path goes pick, hear, change, keep, another, pads, publish, next, then none, each when its thing is done", () => {
  assert.equal(run("pick", ["picked"]), "hear");
  assert.equal(run("pick", ["picked", "heard"]), "change");
  assert.equal(run("pick", ["picked", "heard", "changed"]), "keep");
  assert.equal(run("pick", ["picked", "heard", "changed", "kept"]), "another");
  assert.equal(run("pick", ["picked", "heard", "changed", "kept", "kept"]), "pads");
  assert.equal(run("pick", ["picked", "heard", "changed", "kept", "kept", "banked"]), "publish");
  assert.equal(
    run("pick", ["picked", "heard", "changed", "kept", "kept", "banked", "published"]),
    "next",
  );
  assert.equal(
    run("pick", ["picked", "heard", "changed", "kept", "kept", "banked", "published", "faded"]),
    "done",
  );
});

test("going on from a sketch counts as another try", () => {
  assert.equal(run("keep", ["kept", "wentOn"]), "pads");
  assert.equal(run("another", ["wentOn"]), "pads");
});

test("doing a later thing first skips the lines in between and never goes back", () => {
  assert.equal(run("hear", ["changed"]), "keep", "moving a control means it was heard");
  assert.equal(run("hear", ["kept"]), "another");
  assert.equal(run("keep", ["banked"]), "publish");
  assert.equal(run("another", ["published"]), "next");
  assert.equal(run("change", ["heard"]), "change");
  assert.equal(run("pads", ["heard", "changed", "picked"]), "pads");
  assert.equal(run("publish", ["kept", "banked"]), "publish");
  assert.equal(run("next", ["kept", "published"]), "next");
});

test("a build with no pads goes from another try straight to publish", () => {
  assert.equal(run("another", ["kept"], false), "publish");
  assert.equal(run("keep", ["kept", "wentOn"], false), "publish");
});

test("the last line fades by itself, and only the last", () => {
  assert.equal(run("next", ["faded"]), "done");
  for (const p of ["pick", "hear", "change", "keep", "another", "pads", "publish"] as const)
    assert.equal(run(p, ["faded"]), p);
});

test("skip ends the hints from any line, and nothing brings them back", () => {
  for (const p of ["pick", "hear", "change", "keep", "another", "pads", "publish", "next"] as const)
    assert.equal(next(p, "skipped"), "done");
  assert.equal(
    run("done", ["picked", "heard", "changed", "kept", "wentOn", "banked", "published", "faded"]),
    "done",
  );
});

test("a replay begins at the picker, or at hear it when a sound is already in the editor", () => {
  assert.equal(replayAt(false), "pick");
  assert.equal(replayAt(true), "hear");
});

test("the make mark and the roll's progress sit in one word and neither undoes the other", () => {
  const store = new Memory();
  assert.equal(readMade(store), false);
  writeMade(store);
  assert.equal(store.items.get(COACH_KEY), "made");
  assert.equal(readPhase(store), "armed", "making first does not count as the roll's guide");
  writePhase("hintNeedle", store);
  assert.equal(store.items.get(COACH_KEY), "narrated+made");
  writePhase("hintPerform", store);
  assert.equal(store.items.get(COACH_KEY), "done+made");
  writePhase("done", store);
  assert.equal(store.items.get(COACH_KEY), "keys+made");
  writePhase("hintNeedle", store); // a replay passes through the early phases again
  writeMade(store);
  assert.equal(store.items.get(COACH_KEY), "keys+made");
  assert.equal(readPhase(store), "done");
  assert.equal(readMade(store), true);
  assert.ok(store.writes.every((w) => (COACH_VALUES as readonly string[]).includes(w)));
});

test("the roll's progress is kept when the make mark is added, and the other way round", () => {
  const roll = new Memory();
  roll.items.set(COACH_KEY, "needle");
  writeMade(roll);
  assert.equal(roll.items.get(COACH_KEY), "needle+made");
  assert.equal(readPhase(roll), "hintMark");
  const both = new Memory();
  both.items.set(COACH_KEY, "keys+made");
  assert.equal(readPhase(both), "done");
  assert.equal(readMade(both), true);
});

test("a word nobody wrote reads as nothing shown, and blocked storage never throws", () => {
  const odd = new Memory();
  odd.items.set(COACH_KEY, "seen");
  assert.equal(readPhase(odd), "armed");
  assert.equal(readMade(odd), false);
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readMade(blocked), false);
  writeMade(blocked);
  writePhase("done", blocked);
});

test("a fresh browser starts at the beginning, and one that finished the older guide sees the sketch part once", () => {
  assert.equal(startPhase(new Memory()), "pick");
  const old = new Memory();
  old.items.set(COACH_KEY, "keys+made");
  assert.equal(startPhase(old), "keep");
  writeProgress("keep", old);
  writeProgress("done", old);
  assert.equal(startPhase(old), "done", "once seen, never again");
  assert.equal(old.items.get(COACH_KEY), "keys+made", "the roll's word is untouched");
});

test("progress is kept under its own key, resumes at the right line, and only goes forward", () => {
  const store = new Memory();
  writeProgress("pick", store);
  assert.equal(store.items.has(SKETCH_GUIDE_KEY), false, "the first line is not progress");
  writeProgress("change", store);
  assert.equal(startPhase(store), "change");
  writeProgress("pads", store);
  writeProgress("hear", store); // a replay passes back through the early lines
  assert.equal(startPhase(store), "pads");
  assert.equal(
    store.items.get(COACH_KEY),
    "made",
    "reaching the sketch part sets the older mark too",
  );
  assert.equal(readMade(store), true);
});

test("a word this build does not know is read as finished, and never touches the roll's narration", () => {
  const store = new Memory();
  store.items.set(SKETCH_GUIDE_KEY, "some-future-word");
  assert.equal(startPhase(store), "done");
  store.items.set(SKETCH_GUIDE_KEY, "pick");
  assert.equal(startPhase(store), "done");
  assert.equal(readPhase(store), "armed", "the roll's guide is read from its own key only");
});

test("a browser that blocks storage shows the guide again and nothing throws", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(startPhase(blocked), "pick");
  writeProgress("next", blocked);
});
