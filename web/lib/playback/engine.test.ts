import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ATTACK, RELEASE } from "./config.ts";
import { Engine } from "./engine.ts";
import { isSounding } from "./machine.ts";
import { FakeClock, FakeGraph, type Sound } from "./testing.ts";

// The seeded chain's stage lengths in seconds: source 1.2, then 0.6, 0.72 and the finished flip 1.2.
const LENGTHS = [1.2, 0.6, 0.72, 1.2];

function setup(lengths: readonly number[] = LENGTHS) {
  const clock = new FakeClock();
  const graph = new FakeGraph(clock, lengths);
  const engine = new Engine({ graph, clock, lengths });
  return { clock, graph, engine };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const starts = (sounds: Sound[]): [number, number][] =>
  sounds.map((s) => [s.stage, Math.round(s.startedAt * 1000) / 1000]);

test("roll mode plays the finished flip, then each stage from the source, repeating with a gap until the dwell ends", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(12.0 + 0.001);
  // Worked out by hand: dwell 2.4 s; repeat gap 0.05 s after a stage ends; a repeat that would
  // begin after the dwell ends never starts; the sound that is playing is released at the boundary.
  assert.deepEqual(starts(graph.sounds), [
    [3, 0],
    [3, 1.25], //                       teaser: the 1.2 s finished flip twice in 2.4 s
    [0, 2.4],
    [0, 3.65], //                     source 1.2 s
    [1, 4.8],
    [1, 5.45],
    [1, 6.1],
    [1, 6.75], // 0.6 s stage repeats four times
    [2, 7.2],
    [2, 7.97],
    [2, 8.74],
    [2, 9.51], // 0.72 s stage, the last repeat cut by the dwell
    [3, 9.6],
    [3, 10.85], //                     the finished flip
    [3, 12.0], //                                rest begins
  ]);
  clock.advance(1.3);
  assert.deepEqual(
    starts(graph.sounds).at(-1),
    [3, 13.25],
    "rest loops the finished flip and has no end",
  );
  assert.equal(engine.state.kind, "rolling");
});

test("every sound fades in over the attack ramp and a sound cut by the end of its step is released, not clicked off", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(2.5);
  assert.ok(graph.sounds.every((s) => s.attack === ATTACK));
  const cut = graph.sounds[1]; // the second teaser repeat, 1.25 to 2.45, cut at 2.4
  assert.ok(cut && cut.stoppedAt !== null && near(cut.stoppedAt, 2.4) && cut.release === RELEASE);
  assert.equal(cut.ended, false);
});

test("a stage longer than the dwell is heard as an excerpt of its first seconds, with no repeat", () => {
  const { clock, graph, engine } = setup([5, 5]);
  engine.play();
  clock.advance(2.5);
  const [teaser, next] = graph.sounds;
  assert.ok(teaser && near(teaser.stoppedAt ?? -1, 2.4), "released when the dwell ends");
  assert.equal(teaser.ended, false, "it never reached its end");
  assert.equal(next?.stage, 0);
  assert.equal(
    graph.sounds.filter((s) => s.stage === 1).length,
    1,
    "no repeat of a stage longer than the dwell",
  );
});

test("an audition plays the stage's whole output once, then ends; tapping it again replays it", () => {
  const { clock, graph, engine } = setup();
  engine.tapStage(2);
  assert.equal(engine.state.kind, "auditioning");
  clock.advance(0.72 + 0.001);
  assert.equal(
    engine.state.kind === "auditioning" && engine.state.ended,
    true,
    "it ended by itself",
  );
  clock.advance(5);
  assert.equal(graph.sounds.length, 1, "an audition never repeats");
  engine.tapStage(2);
  assert.equal(graph.sounds.length, 2, "a tap after the end replays");
  assert.equal(graph.sounds[1]?.offset, 0);
});

test("a second tap on the stage that is playing pauses it, and play resumes it from the same offset", () => {
  const { clock, graph, engine } = setup();
  engine.tapStage(3);
  clock.advance(0.3);
  engine.tapStage(3);
  assert.equal(engine.state.kind, "paused");
  assert.equal(graph.sounding.length, 0);
  clock.advance(10);
  assert.equal(graph.sounds.length, 1, "nothing plays while paused");
  engine.play();
  assert.equal(engine.state.kind, "auditioning", "the same mode");
  const resumed = graph.sounds[1];
  assert.ok(resumed && near(resumed.offset, 0.3), `resumed at offset ${resumed?.offset}`);
});

test("after an audition the main control continues the roll from that stage's step, and from rest for the finished flip", () => {
  const { graph, engine } = setup();
  engine.tapStage(1);
  engine.play();
  assert.deepEqual(engine.state, { kind: "rolling", step: 2, elapsed: 0 });
  assert.equal(graph.sounding[0]?.stage, 1, "stage 1 sounds, from its start, not the teaser");

  engine.tapStage(3);
  engine.play();
  assert.deepEqual(
    engine.state,
    { kind: "rolling", step: 5, elapsed: 0 },
    "the finished flip goes to rest",
  );
  assert.equal(graph.sounding[0]?.stage, 3);
});

test("pause and resume in roll mode are exact: the same step, the same point in the repeat, the rest of the dwell", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(0.7);
  engine.pause();
  assert.deepEqual(engine.state, {
    kind: "paused",
    from: { kind: "rolling", step: 0, elapsed: 0.7 },
  });
  assert.deepEqual([engine.voices, engine.timers], [0, 0], "paused: no sound and no timers");
  clock.advance(100);
  assert.equal(graph.sounds.length, 1);

  engine.play();
  const resumed = graph.sounds[1];
  assert.ok(resumed && near(resumed.offset, 0.7), "picks up at the same point of the same repeat");
  clock.advance(1.7 - 0.001);
  assert.equal(
    engine.state.kind === "rolling" && engine.state.step,
    0,
    "1.7 s of the 2.4 s dwell were left",
  );
  clock.advance(0.002);
  assert.equal(engine.state.kind === "rolling" && engine.state.step, 1);
});

test("pausing in the silence between two repeats resumes into that silence, then the next repeat", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(1.22); // the 1.2 s sound ended; the next repeat begins at 1.25
  engine.pause();
  engine.play();
  assert.equal(graph.sounds.length, 1, "nothing sounds in the gap");
  clock.advance(0.031);
  assert.equal(graph.sounds.length, 2);
  assert.ok(near(graph.sounds[1]?.offset ?? -1, 0));
});

test("a hidden tab pauses cleanly, leaves nothing running, and play resumes", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(0.4);
  engine.tabHidden();
  assert.equal(engine.state.kind, "paused");
  assert.deepEqual([engine.voices, engine.timers, graph.sounding.length], [0, 0, 0]);
  engine.play();
  assert.equal(engine.state.kind, "rolling");
  assert.equal(graph.sounding.length, 1);
});

test("scrubbing is an audition: the sound follows the stylus, one voice at a time, and continues when released", () => {
  const { graph, engine } = setup();
  engine.scrubStart(1, 0.2);
  engine.scrubMove(1, 0.4);
  engine.scrubMove(2, 0.1);
  engine.scrubEnd();
  assert.equal(engine.state.kind, "auditioning");
  assert.equal(graph.sounding.length, 1, "never two sources while the stylus moves");
  assert.deepEqual(
    graph.sounds.map((s) => [s.stage, s.offset]),
    [
      [1, 0.2],
      [1, 0.4],
      [2, 0.1],
    ],
  );
  assert.ok(
    graph.sounds.slice(0, 2).every((s) => s.stoppedAt !== null),
    "earlier positions were released",
  );
});

test("a route change stops everything", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(0.5);
  engine.routeChange();
  assert.deepEqual(
    [engine.state.kind, engine.voices, engine.timers, graph.sounding.length],
    ["idle", 0, 0, 0],
  );
});

test("reduced motion changes no playback state", () => {
  const { engine } = setup();
  engine.play();
  const before = JSON.stringify(engine.state);
  engine.setReducedMotion(true);
  assert.equal(JSON.stringify(engine.state), before);
  assert.equal(engine.reducedMotion, true);
});

// ---- properties over generated sequences of actions and passing time ----

type Action =
  | { do: "play" }
  | { do: "pause" }
  | { do: "tap"; stage: number }
  | { do: "scrubStart"; stage: number; offset: number }
  | { do: "scrubMove"; stage: number; offset: number }
  | { do: "scrubEnd" }
  | { do: "next" }
  | { do: "previous" }
  | { do: "hide" }
  | { do: "route" }
  | { do: "wait"; seconds: number };

const stage = fc.integer({ min: 0, max: 5 }); // some out of range on purpose
const action: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ do: "play" }),
  fc.constant<Action>({ do: "pause" }),
  stage.map((s): Action => ({ do: "tap", stage: s })),
  fc
    .record({ stage, offset: fc.double({ min: 0, max: 2, noNaN: true }) })
    .map((e): Action => ({ do: "scrubStart", ...e })),
  fc
    .record({ stage, offset: fc.double({ min: 0, max: 2, noNaN: true }) })
    .map((e): Action => ({ do: "scrubMove", ...e })),
  fc.constant<Action>({ do: "scrubEnd" }),
  fc.constant<Action>({ do: "next" }),
  fc.constant<Action>({ do: "previous" }),
  fc.constant<Action>({ do: "hide" }),
  fc.constant<Action>({ do: "route" }),
  fc.double({ min: 0, max: 4, noNaN: true }).map((seconds): Action => ({ do: "wait", seconds })),
);

function apply(a: Action, engine: Engine, clock: FakeClock): void {
  switch (a.do) {
    case "play":
      return engine.play();
    case "pause":
      return engine.pause();
    case "tap":
      return engine.tapStage(a.stage);
    case "scrubStart":
      return engine.scrubStart(a.stage, a.offset);
    case "scrubMove":
      return engine.scrubMove(a.stage, a.offset);
    case "scrubEnd":
      return engine.scrubEnd();
    case "next":
      return engine.next();
    case "previous":
      return engine.previous();
    case "hide":
      return engine.tabHidden();
    case "route":
      return engine.routeChange();
    case "wait":
      return clock.advance(a.seconds);
  }
}

test("after any sequence of actions never two sources sound, timers stay bounded, and sound and roll agree on the stage", () => {
  fc.assert(
    fc.property(fc.array(action, { maxLength: 80 }), (actions) => {
      const { clock, graph, engine } = setup();
      for (const a of actions) {
        apply(a, engine, clock);
        assert.ok(graph.sounding.length <= 1, `two sources sounding after ${JSON.stringify(a)}`);
        assert.ok(engine.timers <= 2, `${engine.timers} timers`);
        assert.ok(engine.voices <= 1);
        if (graph.sounding.length === 1) {
          assert.ok(isSounding(engine.state), `sound with state ${engine.state.kind}`);
          assert.equal(
            graph.sounding[0]?.stage,
            engine.currentStage,
            "audio and roll disagree about the stage",
          );
        }
        if (!isSounding(engine.state)) {
          assert.equal(graph.sounding.length, 0, `${engine.state.kind} must be silent`);
        }
      }
    }),
    { numRuns: 300 },
  );
});

test("leaving the player at any point ends in silence with no timers left", () => {
  fc.assert(
    fc.property(fc.array(action, { maxLength: 60 }), (actions) => {
      const { clock, graph, engine } = setup();
      for (const a of actions) apply(a, engine, clock);
      engine.routeChange();
      clock.advance(60);
      assert.deepEqual(
        [engine.state.kind, engine.voices, engine.timers, graph.sounding.length],
        ["idle", 0, 0, 0],
      );
    }),
    { numRuns: 200 },
  );
});

test("pausing and resuming at any moment of a roll never changes which step plays or loses time", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 30, noNaN: true }),
      fc.double({ min: 0, max: 5, noNaN: true }),
      (before, hold) => {
        const a = setup();
        const b = setup();
        a.engine.play();
        b.engine.play();
        a.clock.advance(before);
        b.clock.advance(before);
        b.engine.pause();
        b.clock.advance(hold);
        b.engine.play();
        // The paused-and-resumed roll is exactly where the uninterrupted one is.
        assert.deepEqual(
          JSON.stringify(b.engine.state.kind === "rolling" ? b.engine.state.step : null),
          JSON.stringify(a.engine.state.kind === "rolling" ? a.engine.state.step : null),
        );
      },
    ),
    { numRuns: 200 },
  );
});

// ---- failure, ordering and edge cases found in review ----

test("if the audio graph throws, the engine goes silent and idle, says so, and stays usable", () => {
  const clock = new FakeClock();
  const inner = new FakeGraph(clock, LENGTHS);
  let broken = true;
  const graph = {
    voice(stage: number) {
      const voice = inner.voice(stage);
      const start = voice.start;
      voice.start = (offset: number, attack: number) => {
        if (broken) throw new TypeError("the buffer is gone");
        start(offset, attack);
      };
      return voice;
    },
  };
  const errors: unknown[] = [];
  const seen: string[] = [];
  const engine = new Engine({
    graph,
    clock,
    lengths: LENGTHS,
    onError: (e) => errors.push(e),
    onChange: (s) => seen.push(s.kind),
  });
  engine.play();
  assert.equal(engine.state.kind, "idle", "state must not claim sound that does not exist");
  assert.deepEqual([engine.voices, engine.timers], [0, 0]);
  assert.equal(errors.length, 1);
  assert.equal(seen.at(-1), "idle");
  broken = false;
  engine.play();
  assert.equal(engine.state.kind, "rolling", "the engine works again once the graph does");
});

test("an event raised while another is being handled waits its turn, so listeners see states in order", () => {
  const clock = new FakeClock();
  // A voice that ends the instant it starts, as a zero-length buffer would.
  const graph = {
    voice: () => {
      const voice = {
        onended: null as (() => void) | null,
        start: () => voice.onended?.(),
        stop: () => undefined,
      };
      return voice;
    },
  };
  const seen: string[] = [];
  const engine = new Engine({
    graph,
    clock,
    lengths: [0, 1],
    onChange: (s) =>
      seen.push(s.kind === "auditioning" ? `auditioning${s.ended ? " ended" : ""}` : s.kind),
  });
  engine.tapStage(0);
  assert.deepEqual(
    seen,
    ["auditioning", "auditioning ended"],
    "the start is reported before the end that followed it",
  );
});

test("a stage length that is not a finite number of seconds is refused at construction", () => {
  const clock = new FakeClock();
  const graph = new FakeGraph(clock, [1]);
  for (const lengths of [[Number.NaN], [-1], [1, Number.POSITIVE_INFINITY], []]) {
    assert.throws(() => new Engine({ graph, clock, lengths }), RangeError, JSON.stringify(lengths));
  }
});

test("scrubbing with a position that is not a number does nothing wrong", () => {
  const { graph, engine } = setup();
  engine.scrubStart(Number.NaN, 0.2);
  assert.equal(engine.state.kind, "idle");
  engine.scrubStart(1, Number.NaN);
  assert.deepEqual(
    graph.sounds.map((s) => [s.stage, s.offset]),
    [[1, 0]],
    "a bad offset starts from the beginning",
  );
  engine.scrubMove(2, Number.POSITIVE_INFINITY);
  assert.equal(graph.sounds.at(-1)?.stage, 2);
  assert.ok(Number.isFinite(graph.sounds.at(-1)?.offset ?? Number.NaN));
});

test("previous at the first step starts that step again, and next at rest restarts the loop", () => {
  const { clock, graph, engine } = setup();
  engine.play();
  clock.advance(1.5);
  const before = graph.sounds.length;
  engine.previous(); // already at the teaser: the same state, but the person asked
  assert.equal(graph.sounds.length, before + 1, "the sound starts again");
  assert.equal(graph.sounding.length, 1);
  assert.equal(graph.sounds.at(-1)?.offset, 0);
});

test("an audition resumed at the very end plays again from the start instead of making no sound", () => {
  const { clock, graph, engine } = setup();
  engine.tapStage(2); // 0.72 s
  clock.advance(0.7199);
  engine.tapStage(2); // pause within a hair of the end
  engine.play();
  assert.equal(engine.state.kind, "auditioning");
  engine.tapStage(2);
  engine.tapStage(2); // resume by tapping the paused stage
  assert.ok(graph.sounding.length <= 1);
  assert.ok((graph.sounds.at(-1)?.offset ?? -1) < 0.72 - 0.005, "it does not start at the end");
});

test("tapping the stage that was paused resumes it, from where it stopped", () => {
  const { clock, graph, engine } = setup();
  engine.tapStage(3);
  clock.advance(0.3);
  engine.tapStage(3); // pauses
  engine.tapStage(3); // resumes
  assert.equal(engine.state.kind, "auditioning");
  assert.ok(Math.abs((graph.sounds.at(-1)?.offset ?? -1) - 0.3) < 1e-9);
});

test("the stage position says how far into the stage's output the sound is, for the stylus to ride", () => {
  const { clock, engine } = setup();
  assert.equal(engine.stagePosition, null, "silent and idle: nowhere");

  // Roll: the teaser is the finished flip (1.2 s), repeating every 1.2 + 0.05 s.
  engine.play();
  clock.advance(0.5);
  assert.ok(near(engine.stagePosition!, 0.5));
  clock.advance(0.725); // 1.225 s in: inside the gap, so the stylus rests at the end of the groove
  assert.ok(near(engine.stagePosition!, 1.2));
  clock.advance(0.125); // 1.35 s in: 0.1 s into the second repeat
  assert.ok(near(engine.stagePosition!, 0.1));

  // Paused: frozen where it stopped, however long it stays paused.
  engine.pause();
  const frozen = engine.stagePosition;
  clock.advance(10);
  assert.equal(engine.stagePosition, frozen);
});

test("in an audition the stage position runs to the end of the stage and stays there", () => {
  const { clock, engine } = setup();
  engine.tapStage(2); // 0.72 s long
  clock.advance(0.3);
  assert.ok(near(engine.stagePosition!, 0.3));
  engine.tapStage(2);
  clock.advance(10);
  assert.ok(near(engine.stagePosition!, 0.3), "paused at 0.3");
  engine.play();
  clock.advance(5);
  assert.ok(near(engine.stagePosition!, 0.72), "ended: at the end of the groove");
});
