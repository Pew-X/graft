// The guide's order and its "once": each guarantee is a sequence of events and where it must end up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, next, type Doing, type Event, type Phase } from "./first.ts";
import { COACH_KEY, COACH_VALUES, readPhase, writePhase } from "./seen.ts";

const run = (start: Phase, events: Event[]): Phase => events.reduce(next, start);

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

test("the guide goes narration, needle hint, mark hint, done, in that order", () => {
  assert.equal(run("armed", ["rolled"]), "narrating");
  assert.equal(run("armed", ["rolled", "narrationEnded"]), "hintNeedle");
  assert.equal(run("armed", ["rolled", "narrationEnded", "hintFaded"]), "hintMark");
  assert.equal(run("armed", ["rolled", "narrationEnded", "hintFaded", "hintFaded"]), "done");
});

test("skipping the narration leads to the first hint, not to both at once", () => {
  assert.equal(run("armed", ["rolled", "skipped"]), "hintNeedle");
});

test("taking over during the narration ends it and moves on to the hints", () => {
  assert.equal(run("armed", ["rolled", "tookOver"]), "hintNeedle");
});

test("a visitor who starts with the needle is not narrated to; the hint they have just done is gone", () => {
  assert.equal(run("armed", ["tookOver"]), "hintNeedle");
  assert.equal(run("armed", ["tookOver", "needleUsed"]), "hintMark");
});

test("doing the thing a hint says dismisses it at once, and marking ends the guide", () => {
  assert.equal(run("hintNeedle", ["needleUsed"]), "hintMark");
  assert.equal(run("hintMark", ["marked"]), "done");
});

test("an event that does not belong to the phase changes nothing", () => {
  assert.equal(
    run("armed", ["narrationEnded", "skipped", "needleUsed", "marked", "hintFaded"]),
    "armed",
  );
  assert.equal(run("narrating", ["rolled", "needleUsed", "marked"]), "narrating");
  assert.equal(run("hintNeedle", ["rolled", "marked", "skipped"]), "hintNeedle");
  assert.equal(run("hintMark", ["rolled", "needleUsed", "skipped"]), "hintMark");
});

test("nothing returns after the guide is done, except by the footer's replay", () => {
  const events: Event[] = [
    "rolled",
    "tookOver",
    "narrationEnded",
    "skipped",
    "needleUsed",
    "marked",
    "hintFaded",
  ];
  assert.equal(run("done", events), "done");
  assert.equal(run("done", ["replay"]), "narrating");
  assert.equal(run("hintMark", ["replay", "narrationEnded", "hintFaded", "hintFaded"]), "done");
});

test("the browser keeps only a word, and only goes forward", () => {
  const store = new Memory();
  assert.equal(readPhase(store), "armed");
  writePhase("armed", store);
  writePhase("narrating", store);
  assert.deepEqual(store.writes, [], "nothing is stored before the first play is over");
  writePhase("hintNeedle", store);
  assert.equal(store.items.get(COACH_KEY), "narrated");
  assert.equal(readPhase(store), "hintNeedle");
  writePhase("hintMark", store);
  assert.equal(readPhase(store), "hintMark");
  writePhase("done", store);
  assert.equal(readPhase(store), "done");
  writePhase("hintNeedle", store); // a replay passes through the early phases again
  assert.equal(store.items.get(COACH_KEY), "done");
  assert.deepEqual(store.writes, ["narrated", "needle", "done"]);
  assert.ok(store.writes.every((w) => (COACH_VALUES as readonly string[]).includes(w)));
});

test("a browser that kept the earlier coach's word starts the new guide from the beginning", () => {
  const store = new Memory();
  store.items.set(COACH_KEY, "seen");
  assert.equal(readPhase(store), "armed");
  writePhase("hintNeedle", store);
  assert.equal(store.items.get(COACH_KEY), "narrated");
});

test("a browser that blocks storage shows the guide again and nothing throws", () => {
  const blocked = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  assert.equal(readPhase(blocked), "armed");
  assert.doesNotThrow(() => writePhase("done", blocked));
  assert.equal(readPhase(null), "armed");
});

const doing = (sounding: Doing["sounding"], marking = false): Doing => ({ sounding, marking });

test("what the visitor does moves the guide: the first sound narrates, the needle ends it, marking is the last hint", () => {
  assert.equal(follow("armed", doing("idle")), null);
  assert.equal(follow("armed", doing("rolling")), "rolled");
  assert.equal(follow("armed", doing("auditioning")), "tookOver");
  assert.equal(follow("narrating", doing("rolling")), null, "the roll is what is being narrated");
  assert.equal(follow("narrating", doing("paused")), null);
  assert.equal(follow("narrating", doing("auditioning")), "tookOver");
  assert.equal(follow("hintNeedle", doing("auditioning")), "needleUsed");
  assert.equal(follow("hintNeedle", doing("rolling")), null, "the roll playing is not the needle");
  assert.equal(follow("hintMark", doing("auditioning")), null);
  assert.equal(follow("hintMark", doing("idle", true)), "marked");
  assert.equal(follow("done", doing("auditioning", true)), null);
});

test("following the visitor always comes to rest: nothing they do loops the guide", () => {
  for (const sounding of ["idle", "rolling", "auditioning", "paused"] as const) {
    for (const marking of [false, true]) {
      let phase: Phase = "armed";
      let settled = false;
      for (let step = 0; step < 6; step++) {
        const event = follow(phase, { sounding, marking });
        if (event === null) {
          settled = true;
          break;
        }
        const after = next(phase, event);
        assert.notEqual(after, phase, `${sounding}/${marking} stays in ${phase}`);
        phase = after;
      }
      assert.ok(settled, `${sounding}/${marking} never settles`);
    }
  }
});
