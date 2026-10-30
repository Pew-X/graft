// The make flow's hints: the order, the "once", and what a replay and a skip do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next, replayAt, type MakeEvent, type MakePhase } from "./make.ts";
import { COACH_KEY, COACH_VALUES, readMade, readPhase, writeMade, writePhase } from "./seen.ts";

const run = (start: MakePhase, events: MakeEvent[]): MakePhase => events.reduce(next, start);

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

test("the hints go pick, hear, change, share, then none, each when its thing is done", () => {
  assert.equal(run("pick", ["picked"]), "hear");
  assert.equal(run("pick", ["picked", "heard"]), "change");
  assert.equal(run("pick", ["picked", "heard", "changed"]), "share");
  assert.equal(run("pick", ["picked", "heard", "changed", "shared"]), "done");
});

test("doing a later thing first skips the lines in between and never goes back", () => {
  assert.equal(run("hear", ["changed"]), "share", "moving a control means it was heard");
  assert.equal(run("hear", ["shared"]), "done");
  assert.equal(run("change", ["heard"]), "change");
  assert.equal(run("share", ["heard", "changed"]), "share");
});

test("the last line fades by itself, and only the last", () => {
  assert.equal(run("share", ["faded"]), "done");
  assert.equal(run("pick", ["faded"]), "pick");
  assert.equal(run("hear", ["faded"]), "hear");
  assert.equal(run("change", ["faded"]), "change");
});

test("skip ends the hints from any line, and nothing brings them back", () => {
  for (const p of ["pick", "hear", "change", "share"] as const)
    assert.equal(next(p, "skipped"), "done");
  assert.equal(run("done", ["picked", "heard", "changed", "shared", "faded"]), "done");
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
