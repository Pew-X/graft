import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  encodePhrase,
  MOST_PRESSES,
  MOST_UNITS,
  parsePhraseHash,
  PhrasePlayer,
  PhraseRecorder,
  type Phrase,
} from "./phrase.ts";

/** A clock and a timer queue that only move when the test says so. */
function fake() {
  let t = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn: () => void, seconds: number) => {
      const id = next++;
      queue.set(id, { at: t + Math.max(0, seconds), fn });
      return id;
    },
    clearTimeout: (id: unknown) => void queue.delete(id as number),
    set(seconds: number) {
      t = seconds;
    },
    /** Move time forward, running what falls due, in order. */
    advance(seconds: number) {
      const end = t + seconds;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, e]) => e.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
  };
}

test("a phrase round-trips through the address", () => {
  const phrase: Phrase = [
    { stage: 0, at: 0 },
    { stage: 2, at: 35 },
    { stage: 11, at: 120 },
  ];
  const hash = encodePhrase(phrase);
  assert.equal(hash, "#phrase=1:0,3:35,12:120");
  assert.deepEqual(parsePhraseHash(hash ?? "", 12), phrase);
});

test("encoding starts the phrase at zero and refuses what is too long", () => {
  assert.equal(
    encodePhrase([
      { stage: 1, at: 50 },
      { stage: 0, at: 80 },
    ]),
    "#phrase=2:0,1:30",
  );
  assert.equal(encodePhrase([]), null);
  const many: Phrase = Array.from({ length: MOST_PRESSES + 1 }, (_, i) => ({ stage: 0, at: i }));
  assert.equal(encodePhrase(many), null);
  assert.equal(
    encodePhrase([
      { stage: 0, at: 0 },
      { stage: 0, at: MOST_UNITS + 1 },
    ]),
    null,
  );
  assert.equal(encodePhrase([{ stage: 12, at: 0 }]), null);
  assert.equal(encodePhrase([{ stage: -1, at: 0 }]), null);
});

test("a full phrase stays under two kilobytes", () => {
  const full: Phrase = Array.from({ length: MOST_PRESSES }, (_, i) => ({
    stage: 11,
    at: i * 25,
  }));
  const hash = encodePhrase(full);
  assert.ok(hash !== null && hash.length < 2048);
  assert.equal(parsePhraseHash(hash, 12)?.length, MOST_PRESSES);
});

test("anything that is not exactly what encode writes is no phrase", () => {
  const bad = [
    "",
    "#phrase=",
    "#phrase=1:0,",
    "#phrase=,1:0",
    "#phrase=0:0",
    "#phrase=13:0",
    "#phrase=1:5",
    "#phrase=1:0,2:10,3:5",
    "#phrase=1:0,2:1601",
    "#phrase=1:-1",
    "#phrase=1:0.5",
    "#phrase=01:0",
    "#phrase=1:0;2:1",
    "#phrase=1:0 ",
    "#phrase=1:0,2:1&x",
    "#PHRASE=1:0",
    "#cut=1:0-1",
    "#how",
    "#phrase=<script>",
    `#phrase=${"1:0,".repeat(MOST_PRESSES + 1)}1:0`,
    `#phrase=${"1:0,".repeat(3000)}`,
    "#phrase=1:99999999999999999999",
    "#phrase=1e3:0",
    "#phrase=١:0",
  ];
  for (const hash of bad) assert.equal(parsePhraseHash(hash, 12), null, JSON.stringify(hash));
});

test("a stage the chain does not have makes the whole link no phrase", () => {
  assert.equal(parsePhraseHash("#phrase=1:0,5:10", 4), null);
  assert.ok(parsePhraseHash("#phrase=1:0,4:10", 4));
});

test("parse never throws and anything it accepts encodes back to itself", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (s) => {
      const got = parsePhraseHash(`#phrase=${s}`, 12);
      if (got) assert.equal(encodePhrase(got), `#phrase=${s}`);
    }),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 0, max: 11 }), fc.integer({ min: 0, max: 40 })), {
        minLength: 1,
        maxLength: MOST_PRESSES,
      }),
      (steps) => {
        let at = 0;
        const phrase: Phrase = steps.map(([stage, gap], i) => {
          if (i > 0) at += gap;
          return { stage, at };
        });
        const hash = encodePhrase(phrase);
        assert.ok(hash);
        assert.deepEqual(parsePhraseHash(hash, 12), phrase);
      },
    ),
  );
});

test("the recorder keeps the stage and the time of each press, in hundredths of a second", () => {
  const c = fake();
  const rec = new PhraseRecorder(c.now);
  assert.equal(rec.note(3), false, "not recording yet");
  rec.start();
  c.set(10);
  assert.equal(rec.note(1), true);
  c.set(10.354);
  assert.equal(rec.note(0), true);
  c.set(11.2);
  assert.equal(rec.note(1), true);
  assert.deepEqual(rec.stop(), [
    { stage: 1, at: 0 },
    { stage: 0, at: 35 },
    { stage: 1, at: 120 },
  ]);
  assert.equal(rec.active, false);
});

test("the recorder ends at sixty-four presses or sixteen seconds", () => {
  const c = fake();
  const rec = new PhraseRecorder(c.now);
  rec.start();
  for (let i = 0; i < MOST_PRESSES; i++) assert.equal(rec.note(0), true);
  assert.equal(rec.note(0), false);
  assert.equal(rec.full, true);
  assert.equal(rec.stop().length, MOST_PRESSES);

  rec.start();
  assert.equal(rec.note(0), true);
  c.set(16.01);
  assert.equal(rec.note(0), false);
  assert.equal(rec.full, true);
  assert.equal(rec.stop().length, 1);
});

test("a recorder that was started again forgets the last phrase", () => {
  const c = fake();
  const rec = new PhraseRecorder(c.now);
  rec.start();
  rec.note(2);
  rec.stop();
  rec.start();
  assert.deepEqual(rec.stop(), []);
});

test("the player presses each stage at its recorded time, once", () => {
  const c = fake();
  const got: Array<[number, number]> = [];
  let ended = 0;
  const player = new PhrasePlayer({
    press: (stage) => got.push([stage, c.now()]),
    timers: c,
    onEnd: () => ended++,
  });
  player.play(
    [
      { stage: 0, at: 0 },
      { stage: 2, at: 35 },
      { stage: 1, at: 120 },
    ],
    false,
  );
  assert.equal(player.playing, true);
  c.advance(2);
  assert.deepEqual(
    got.map(([s, t]) => [s, Math.round(t * 100)]),
    [
      [0, 0],
      [2, 35],
      [1, 120],
    ],
  );
  assert.equal(ended, 1);
  assert.equal(player.playing, false);
});

test("the player keeps its time from the start, not from each press (no drift)", () => {
  const c = fake();
  const times: number[] = [];
  const player = new PhrasePlayer({
    press: () => times.push(c.now()),
    timers: {
      ...c,
      // a late timer: every callback runs 7 ms after it was due
      setTimeout: (fn, s) => c.setTimeout(fn, s + 0.007),
    },
    onEnd: () => undefined,
  });
  player.play(
    Array.from({ length: 10 }, (_, i) => ({ stage: 0, at: i * 10 })),
    false,
  );
  c.advance(1);
  assert.equal(times.length, 10);
  // the last press is about 7 ms late, not 70
  assert.ok(Math.abs((times[9] ?? 0) - 0.9) < 0.016, String(times[9]));
});

test("a loop starts over after a short rest until it is stopped", () => {
  const c = fake();
  const got: number[] = [];
  const player = new PhrasePlayer({
    press: (s) => got.push(s),
    timers: c,
    onEnd: () => undefined,
  });
  player.play(
    [
      { stage: 0, at: 0 },
      { stage: 1, at: 50 },
    ],
    true,
  );
  c.advance(0.55);
  assert.deepEqual(got, [0, 1]);
  c.advance(2);
  assert.ok(got.length > 4, "it went round again");
  player.stop();
  const n = got.length;
  c.advance(5);
  assert.equal(got.length, n);
  assert.equal(player.playing, false);
});

test("the loop switch can be turned off while it plays: the round ends and it stops", () => {
  const c = fake();
  let ended = 0;
  const got: number[] = [];
  const player = new PhrasePlayer({
    press: (s) => got.push(s),
    timers: c,
    onEnd: () => ended++,
  });
  player.play([{ stage: 0, at: 0 }], true);
  c.advance(0.2);
  player.loop = false;
  c.advance(3);
  assert.equal(got.length, 1);
  assert.equal(ended, 1);
});

test("stop is silent about ending, and a new play replaces an old one", () => {
  const c = fake();
  let ended = 0;
  const got: number[] = [];
  const player = new PhrasePlayer({
    press: (s) => got.push(s),
    timers: c,
    onEnd: () => ended++,
  });
  player.play(
    [
      { stage: 0, at: 0 },
      { stage: 1, at: 100 },
    ],
    false,
  );
  c.advance(0.1);
  player.stop();
  c.advance(3);
  assert.deepEqual(got, [0]);
  assert.equal(ended, 0);
  player.play([{ stage: 5, at: 0 }], false);
  player.play([{ stage: 6, at: 0 }], false);
  c.advance(1);
  assert.deepEqual(got, [0, 6]);
});

test("a press that throws does not stop the rest of the phrase", () => {
  const c = fake();
  const got: number[] = [];
  const player = new PhrasePlayer({
    press: (s) => {
      if (s === 1) throw new Error("no");
      got.push(s);
    },
    timers: c,
    onEnd: () => undefined,
  });
  player.play(
    [
      { stage: 0, at: 0 },
      { stage: 1, at: 10 },
      { stage: 2, at: 20 },
    ],
    false,
  );
  c.advance(1);
  assert.deepEqual(got, [0, 2]);
});
