import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { currentStage, idle, isSounding, transition, type Event, type State } from "./machine.ts";
import { restStep } from "./steps.ts";

// A chain of four stages: step 0 teaser (stage 3), steps 1-4 stages 0-3, step 5 rest (stage 3).
const STAGES = 4;

const roll = (step: number, elapsed: number): State => ({ kind: "rolling", step, elapsed });
const aud = (stage: number, offset: number, ended = false): State => ({
  kind: "auditioning",
  stage,
  offset,
  ended,
});
const paused = (from: State): State => {
  if (from.kind !== "rolling" && from.kind !== "auditioning")
    throw new Error("only a playing state can be paused");
  return { kind: "paused", from };
};

const STATES: Record<string, State> = {
  idle,
  "rolling at step 2": roll(2, 0.7),
  "auditioning stage 1": aud(1, 0.2),
  "audition of stage 1 ended": aud(1, 0.9, true),
  "paused while rolling": paused(roll(2, 1.1)),
  "paused while auditioning": paused(aud(1, 0.4)),
};

const EVENTS: Record<string, Event> = {
  play: { type: "play" },
  pause: { type: "pause", position: 0.8 },
  "tap the same stage": { type: "tapStage", stage: 1, position: 0.3 },
  "tap another stage": { type: "tapStage", stage: 3, position: 0.3 },
  "scrub start": { type: "scrubStart", stage: 2, offset: 0.5 },
  "scrub move": { type: "scrubMove", stage: 2, offset: 0.6 },
  "scrub end": { type: "scrubEnd" },
  next: { type: "next" },
  previous: { type: "previous" },
  "dwell ended": { type: "dwellEnded" },
  "audition ended": { type: "auditionEnded" },
  "tab hidden": { type: "tabHidden", position: 0.9 },
  "route change": { type: "routeChange" },
  "reduced motion": { type: "reducedMotion", enabled: true },
};

/**
 * The expected result of every state meeting every event, written by hand from the spec (Appendix E):
 * first press of play, next or previous from idle starts the teaser; a tap on a stage auditions it from the start; a second tap on
 * the stage that is playing pauses it and a tap after its end replays it; scrubbing is always an
 * audition; the main control after an audition resumes roll mode at that stage's step (the finished
 * flip starts the story over at the source); pause and resume are exact and stay in the same mode; stale timer events do nothing.
 */
const EXPECTED: Record<string, Record<string, State>> = {
  idle: {
    play: roll(0, 0),
    pause: idle,
    "tap the same stage": aud(1, 0),
    "tap another stage": aud(3, 0),
    "scrub start": aud(2, 0.5),
    "scrub move": aud(2, 0.6),
    "scrub end": idle,
    next: roll(0, 0),
    previous: roll(0, 0),
    "dwell ended": idle,
    "audition ended": idle,
    "tab hidden": idle,
    "route change": idle,
    "reduced motion": idle,
  },
  "rolling at step 2": {
    play: roll(2, 0.7),
    pause: paused(roll(2, 0.8)),
    "tap the same stage": aud(1, 0),
    "tap another stage": aud(3, 0),
    "scrub start": aud(2, 0.5),
    "scrub move": aud(2, 0.6),
    "scrub end": roll(2, 0.7),
    next: roll(3, 0),
    previous: roll(1, 0),
    "dwell ended": roll(3, 0),
    "audition ended": roll(2, 0.7),
    "tab hidden": paused(roll(2, 0.9)),
    "route change": idle,
    "reduced motion": roll(2, 0.7),
  },
  "auditioning stage 1": {
    play: roll(2, 0), // continues roll mode from the start of stage 1's step
    pause: paused(aud(1, 0.8)),
    "tap the same stage": paused(aud(1, 0.3)), // a second tap pauses
    "tap another stage": aud(3, 0),
    "scrub start": aud(2, 0.5),
    "scrub move": aud(2, 0.6),
    "scrub end": aud(1, 0.2),
    next: aud(2, 0),
    previous: aud(0, 0),
    "dwell ended": aud(1, 0.2),
    "audition ended": aud(1, 0.2, true),
    "tab hidden": paused(aud(1, 0.9)),
    "route change": idle,
    "reduced motion": aud(1, 0.2),
  },
  "audition of stage 1 ended": {
    play: roll(2, 0),
    pause: aud(1, 0.9, true), // nothing is sounding, so nothing to pause
    "tap the same stage": aud(1, 0), // a tap after the end replays
    "tap another stage": aud(3, 0),
    "scrub start": aud(2, 0.5),
    "scrub move": aud(2, 0.6),
    "scrub end": aud(1, 0.9, true),
    next: aud(2, 0),
    previous: aud(0, 0),
    "dwell ended": aud(1, 0.9, true),
    "audition ended": aud(1, 0.9, true),
    "tab hidden": aud(1, 0.9, true),
    "route change": idle,
    "reduced motion": aud(1, 0.9, true),
  },
  "paused while rolling": {
    play: roll(2, 1.1), // exact: the same step, the same time into it
    pause: paused(roll(2, 1.1)),
    "tap the same stage": aud(1, 0),
    "tap another stage": aud(3, 0),
    "scrub start": aud(2, 0.5),
    "scrub move": aud(2, 0.6),
    "scrub end": paused(roll(2, 1.1)),
    next: paused(roll(3, 0)),
    previous: paused(roll(1, 0)),
    "dwell ended": paused(roll(2, 1.1)),
    "audition ended": paused(roll(2, 1.1)),
    "tab hidden": paused(roll(2, 1.1)),
    "route change": idle,
    "reduced motion": paused(roll(2, 1.1)),
  },
  "paused while auditioning": {
    play: aud(1, 0.4), // resumes in the same mode: the audition, from where it stopped
    pause: paused(aud(1, 0.4)),
    "tap the same stage": aud(1, 0.4), // the mirror of the tap that paused it: it resumes
    "tap another stage": aud(3, 0),
    "scrub start": aud(2, 0.5),
    "scrub move": aud(2, 0.6),
    "scrub end": paused(aud(1, 0.4)),
    next: paused(aud(2, 0)),
    previous: paused(aud(0, 0)),
    "dwell ended": paused(aud(1, 0.4)),
    "audition ended": paused(aud(1, 0.4)),
    "tab hidden": paused(aud(1, 0.4)),
    "route change": idle,
    "reduced motion": paused(aud(1, 0.4)),
  },
};

for (const [stateName, state] of Object.entries(STATES)) {
  for (const [eventName, event] of Object.entries(EVENTS)) {
    test(`${stateName}, then ${eventName}`, () => {
      const expected = EXPECTED[stateName]?.[eventName];
      assert.ok(expected, "the table must define every state against every event");
      assert.deepEqual(transition(state, event, STAGES).state, expected);
    });
  }
}

test("the table covers every state against every event, and every event kind is in it", () => {
  assert.equal(Object.keys(STATES).length * Object.keys(EVENTS).length, 6 * 14);
  const kinds = new Set(Object.values(EVENTS).map((e) => e.type));
  assert.deepEqual(
    [...kinds].sort(),
    [
      "auditionEnded",
      "dwellEnded",
      "next",
      "pause",
      "play",
      "previous",
      "reducedMotion",
      "routeChange",
      "scrubEnd",
      "scrubMove",
      "scrubStart",
      "tabHidden",
      "tapStage",
    ].sort(),
  );
});

test("the effects of entering each playing state, and nothing when nothing changes", () => {
  assert.deepEqual(transition(idle, { type: "play" }, STAGES).effects, [
    { type: "stop" },
    { type: "start", stage: 3, offset: 0, mode: "roll" }, // the teaser plays the finished flip
    { type: "dwell", seconds: 2.4 },
  ]);
  assert.deepEqual(transition(roll(4, 0), { type: "next" }, STAGES).effects, [
    { type: "stop" },
    { type: "start", stage: 3, offset: 0, mode: "roll" },
    { type: "cancelDwell" }, // rest has no end
  ]);
  assert.deepEqual(transition(idle, { type: "tapStage", stage: 1, position: 0 }, STAGES).effects, [
    { type: "stop" },
    { type: "cancelDwell" },
    { type: "start", stage: 1, offset: 0, mode: "audition" },
  ]);
  assert.deepEqual(transition(roll(2, 0.7), { type: "pause", position: 0.8 }, STAGES).effects, [
    { type: "stop" },
    { type: "cancelDwell" },
  ]);
  assert.deepEqual(
    transition(paused(roll(2, 1.1)), { type: "play" }, STAGES).effects[2],
    { type: "dwell", seconds: 2.4 - 1.1 },
    "resuming arms the timer for what is left of the step",
  );
  assert.deepEqual(transition(roll(2, 0.7), { type: "play" }, STAGES).effects, []);
});

test("an audition that ends by itself starts nothing again, and a tap after the end starts it once", () => {
  const ended = transition(aud(1, 0.2), { type: "auditionEnded" }, STAGES);
  assert.deepEqual(ended.state, aud(1, 0.2, true));
  assert.ok(
    !ended.effects.some((e) => e.type === "start"),
    "the sound already ended; it must not restart",
  );
  const replay = transition(ended.state, { type: "tapStage", stage: 1, position: 0 }, STAGES);
  assert.equal(replay.effects.filter((e) => e.type === "start").length, 1);
});

test("a move the person asked for restarts the sound even when it lands on the same state", () => {
  const starts = (r: ReturnType<typeof transition>): number =>
    r.effects.filter((e) => e.type === "start").length;
  // Previous at the first step is the same state, but the person pressed it: the step starts again.
  assert.equal(starts(transition(roll(0, 0), { type: "previous" }, STAGES)), 1);
  // Next at rest likewise, and so does an audition of the last stage moved on past the end.
  assert.equal(starts(transition(roll(restStep(STAGES), 0), { type: "next" }, STAGES)), 1);
  assert.equal(starts(transition(aud(3, 0), { type: "next" }, STAGES)), 1);
  // Scrubbing to the offset the sound has already passed re-seeks.
  assert.equal(
    starts(transition(aud(2, 0.5), { type: "scrubMove", stage: 2, offset: 0.5 }, STAGES)),
    1,
  );
  // Whereas a stale event that changes nothing does nothing.
  assert.deepEqual(transition(aud(1, 0.9, true), { type: "auditionEnded" }, STAGES).effects, []);
  assert.deepEqual(transition(roll(2, 0.7), { type: "play" }, STAGES).effects, []);
});

test("a position or stage that is not a finite number is ignored or treated as zero, never passed on", () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const n of bad) {
    assert.deepEqual(
      transition(idle, { type: "scrubStart", stage: n, offset: 0.3 }, STAGES).state,
      idle,
      "a bad stage is ignored",
    );
    assert.deepEqual(
      transition(idle, { type: "tapStage", stage: n, position: 0 }, STAGES).state,
      idle,
    );
    assert.deepEqual(
      transition(idle, { type: "scrubStart", stage: 1, offset: n }, STAGES).state,
      aud(1, 0),
      "a bad offset is zero",
    );
    assert.deepEqual(
      transition(roll(2, 0.7), { type: "pause", position: n }, STAGES).state,
      paused(roll(2, 0)),
      "a bad position is zero",
    );
  }
});

test("a roll goes teaser, source to final, rest, and rest does not end", () => {
  let s: State = idle;
  const seen: number[] = [];
  s = transition(s, { type: "play" }, STAGES).state;
  for (let i = 0; i < 8; i++) {
    seen.push(currentStage(s, STAGES) ?? -1);
    s = transition(s, { type: "dwellEnded" }, STAGES).state;
  }
  assert.deepEqual(
    seen,
    [3, 0, 1, 2, 3, 3, 3, 3],
    "teaser 3, then 0 1 2 3, then rest on 3 for ever",
  );
  assert.equal(s.kind === "rolling" && s.step, restStep(STAGES));
});

// ---- properties over generated event sequences ----

const finite = fc.double({ min: 0, max: 30, noNaN: true });
const wild = fc.oneof(
  finite,
  fc.constant(-1),
  fc.constant(1e9),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
);
const event: fc.Arbitrary<Event> = fc.oneof(
  fc.constant<Event>({ type: "play" }),
  wild.map((position): Event => ({ type: "pause", position })),
  fc
    .record({ stage: fc.integer({ min: -2, max: 9 }), position: wild })
    .map((e): Event => ({ type: "tapStage", ...e })),
  fc
    .record({ stage: fc.integer({ min: -2, max: 9 }), offset: wild })
    .map((e): Event => ({ type: "scrubStart", ...e })),
  fc
    .record({ stage: fc.integer({ min: -2, max: 9 }), offset: wild })
    .map((e): Event => ({ type: "scrubMove", ...e })),
  fc.constant<Event>({ type: "scrubEnd" }),
  fc.constant<Event>({ type: "next" }),
  fc.constant<Event>({ type: "previous" }),
  fc.constant<Event>({ type: "dwellEnded" }),
  fc.constant<Event>({ type: "auditionEnded" }),
  wild.map((position): Event => ({ type: "tabHidden", position })),
  fc.constant<Event>({ type: "routeChange" }),
  fc.boolean().map((enabled): Event => ({ type: "reducedMotion", enabled })),
);

test("any event sequence on any chain length is handled: no throw, positions stay in range", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 14 }),
      fc.array(event, { maxLength: 60 }),
      (stages, events) => {
        let s: State = idle;
        for (const e of events) {
          s = transition(s, e, stages).state;
          const inner = s.kind === "paused" ? s.from : s;
          if (inner.kind === "rolling") {
            assert.ok(inner.step >= 0 && inner.step <= restStep(stages), `step ${inner.step}`);
          }
          if (inner.kind === "auditioning") {
            assert.ok(inner.stage >= 0 && inner.stage < stages, `stage ${inner.stage}`);
          }
        }
      },
    ),
    { numRuns: 300 },
  );
});

test("every effect list that starts sound stops what was sounding first, so two sources never overlap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 14 }),
      fc.array(event, { maxLength: 60 }),
      (stages, events) => {
        let s: State = idle;
        for (const e of events) {
          const { state, effects } = transition(s, e, stages);
          const starts = effects.filter((x) => x.type === "start").length;
          assert.ok(starts <= 1, "at most one start per transition");
          if (starts === 1)
            assert.equal(effects[0]?.type, "stop", "a start is always preceded by a stop");
          if (starts === 0 && effects.length > 0)
            assert.ok(effects.every((x) => x.type === "stop" || x.type === "cancelDwell"));
          s = state;
        }
      },
    ),
    { numRuns: 300 },
  );
});

test("pause then play returns to the same place in the same mode", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 14 }),
      fc.array(event, { maxLength: 40 }),
      finite,
      (stages, events, position) => {
        let s: State = idle;
        for (const e of events) s = transition(s, e, stages).state;
        fc.pre(isSounding(s));
        const before = JSON.stringify(currentStage(s, stages));
        const after = transition(
          transition(s, { type: "pause", position }, stages).state,
          { type: "play" },
          stages,
        ).state;
        assert.equal(JSON.stringify(currentStage(after, stages)), before, "the same stage");
        assert.equal(after.kind, s.kind, "the same mode");
        if (after.kind === "rolling" && s.kind === "rolling") assert.equal(after.step, s.step);
      },
    ),
    { numRuns: 300 },
  );
});

test("leaving the machine through a route change always ends silent and idle", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 14 }),
      fc.array(event, { maxLength: 40 }),
      (stages, events) => {
        let s: State = idle;
        for (const e of events) s = transition(s, e, stages).state;
        const { state, effects } = transition(s, { type: "routeChange" }, stages);
        assert.deepEqual(state, idle);
        assert.ok(
          s.kind === "idle" ? effects.length === 0 : effects.some((x) => x.type === "stop"),
        );
      },
    ),
    { numRuns: 200 },
  );
});
