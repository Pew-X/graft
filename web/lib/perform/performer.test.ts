import assert from "node:assert/strict";
import { test } from "node:test";
import type { Voice } from "../playback/engine.ts";
import { MOST_VOICES, Performer, type PerformGraph } from "./performer.ts";

class FakeVoice implements Voice {
  onended: (() => void) | null = null;
  started: { offset: number; attack: number } | null = null;
  stopped: number | null = null;
  readonly stage: number;
  constructor(stage: number) {
    this.stage = stage;
  }
  start(offset: number, attack: number): void {
    this.started = { offset, attack };
  }
  stop(release: number): void {
    this.stopped = release;
  }
  /** The sound reaching its end by itself. */
  finish(): void {
    this.onended?.();
  }
}

function setup(options: { stages?: number } = {}) {
  const made: FakeVoice[] = [];
  const counts: number[] = [];
  const graph: PerformGraph = {
    voice(stage) {
      const voice = new FakeVoice(stage);
      made.push(voice);
      return voice;
    },
    voices(n) {
      counts.push(n);
    },
  };
  const changes: number[][] = [];
  const performer = new Performer({
    graph,
    stages: options.stages ?? 12,
    onChange: (sounding) => changes.push([...sounding]),
  });
  return { performer, made, counts, changes };
}

test("a press starts that stage's whole sound from its start, with the roll's attack", () => {
  const { performer, made } = setup();
  assert.equal(performer.press(2), true);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0]?.started, { offset: 0, attack: 0.006 });
  assert.deepEqual(performer.sounding, [2]);
});

test("a stage that does not exist makes no voice", () => {
  const { performer, made } = setup({ stages: 4 });
  assert.equal(performer.press(4), false);
  assert.equal(performer.press(-1), false);
  assert.equal(made.length, 0);
});

test("in cut mode a new press releases what sounds, over about twenty milliseconds", () => {
  const { performer, made } = setup();
  performer.press(0);
  performer.press(1);
  assert.equal(made[0]?.stopped, 0.02);
  assert.equal(made[1]?.stopped, null);
  assert.deepEqual(performer.sounding, [1]);
});

test("pressing the pad that sounds restarts it: the old voice is released, a new one starts", () => {
  const { performer, made } = setup();
  performer.press(3);
  performer.press(3);
  assert.equal(made.length, 2);
  assert.equal(made[0]?.stopped, 0.02);
  assert.deepEqual(made[1]?.started, { offset: 0, attack: 0.006 });
  assert.deepEqual(performer.sounding, [3]);
});

test("in layer mode voices overlap, and the same pad still restarts", () => {
  const { performer, made } = setup();
  performer.mode = "layer";
  performer.press(0);
  performer.press(1);
  performer.press(2);
  assert.deepEqual(performer.sounding, [0, 1, 2]);
  assert.equal(
    made.every((v) => v.stopped === null),
    true,
  );
  performer.press(1);
  assert.equal(made[1]?.stopped, 0.02);
  assert.deepEqual(performer.sounding, [0, 2, 1]);
});

test("layer mode holds at most six voices: a seventh releases the oldest over about thirty milliseconds", () => {
  const { performer, made } = setup();
  performer.mode = "layer";
  for (let stage = 0; stage < MOST_VOICES; stage++) performer.press(stage);
  assert.equal(performer.sounding.length, 6);
  performer.press(6);
  assert.equal(performer.sounding.length, 6);
  assert.equal(made[0]?.stopped, 0.03);
  assert.deepEqual(performer.sounding, [1, 2, 3, 4, 5, 6]);
});

test("a voice that ends by itself leaves the list, and an old voice's end never removes a newer one", () => {
  const { performer, made } = setup();
  performer.mode = "layer";
  performer.press(0);
  performer.press(0);
  // the first voice was released and replaced; its end arrives late
  made[0]?.finish();
  assert.deepEqual(performer.sounding, [0]);
  made[1]?.finish();
  assert.deepEqual(performer.sounding, []);
});

test("silence releases everything, says whether anything sounded, and is quiet when nothing did", () => {
  const { performer, made } = setup();
  performer.mode = "layer";
  performer.press(0);
  performer.press(1);
  assert.equal(performer.silence(), true);
  assert.equal(
    made.every((v) => v.stopped === 0.02),
    true,
  );
  assert.deepEqual(performer.sounding, []);
  assert.equal(performer.silence(), false);
});

test("the mix bus is told how many voices sound after every change", () => {
  const { performer, made, counts } = setup();
  performer.mode = "layer";
  performer.press(0);
  performer.press(1);
  made[0]?.finish();
  performer.silence();
  assert.deepEqual(counts, [1, 2, 1, 0]);
});

test("the last stage pressed is remembered, with when, for the stylus to ride", () => {
  const { performer } = setup();
  const lastStage = (): number | undefined => performer.last?.stage;
  assert.equal(lastStage(), undefined);
  performer.press(5);
  assert.equal(lastStage(), 5);
  performer.press(2);
  assert.equal(lastStage(), 2);
});

test("leaving perform forgets the stage last pressed, so a later visit starts with nothing current", () => {
  const { performer } = setup();
  performer.press(3);
  performer.silence();
  assert.equal(
    performer.last?.stage,
    3,
    "after the sound ends the stage stays current, as on the roll",
  );
  performer.reset();
  assert.equal(performer.last, null);
});

test("a graph that throws makes no sound and leaves nothing half-started", () => {
  const graph: PerformGraph = {
    voice() {
      throw new Error("no audio");
    },
    voices() {},
  };
  const performer = new Performer({ graph, stages: 4 });
  assert.equal(performer.press(1), false);
  assert.deepEqual(performer.sounding, []);
});

test("the change callback sees each change once", () => {
  const { performer, changes } = setup();
  performer.press(0);
  performer.press(1);
  performer.silence();
  assert.deepEqual(changes, [[0], [1], []]);
});
