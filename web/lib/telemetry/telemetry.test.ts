// The client's event path against a fake clock, fake ids and a fake network. What is checked is what
// the service relies on (ids in the shapes it accepts, one batch retried with the same ids so repeats
// dedupe) and what a visitor is owed (nothing sent when gated, nothing ever thrown into the page).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Telemetry, type Post, type Reply } from "./telemetry.ts";

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const PUB = "e790b6ycz0yd";

interface Sent {
  body: { events: Array<Record<string, unknown>> };
  keepalive: boolean;
}

function setup(options: { gated?: boolean; replies?: Array<Reply | "throw"> } = {}) {
  let time = 1_700_000_000_000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: Sent[] = [];
  const replies = [...(options.replies ?? [])];
  const post: Post = async (_url, body, keepalive) => {
    sent.push({ body: JSON.parse(body), keepalive });
    const reply = replies.shift() ?? { status: 200 };
    if (reply === "throw") throw new Error("network down");
    return reply;
  };
  let counter = 0;
  const telemetry = new Telemetry({
    endpoint: "https://api.example.test/v1/events",
    gated: options.gated ?? false,
    now: () => time,
    random: (n) => String(++counter).padStart(n, "x"),
    post,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  });
  return {
    telemetry,
    sent,
    timers,
    /** Move time on, run due timers, and let promises settle. */
    async advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        await settle();
      }
      time = target;
    },
    get time() {
      return time;
    },
  };
}
const settle = () => new Promise<void>((r) => setImmediate(r));

test("gated by a privacy signal: nothing is queued, no timer is set, nothing is ever sent", async () => {
  const t = setup({ gated: true });
  t.telemetry.track("roll_opened", PUB);
  t.telemetry.track("stage_played", PUB);
  await t.telemetry.flush();
  t.telemetry.pageHide();
  await t.advance(60_000);
  assert.equal(t.telemetry.queued, 0);
  assert.equal(t.timers.size, 0);
  assert.equal(t.sent.length, 0);
});

test("an event carries only ids, its kind and a time, in the shapes the service accepts", async () => {
  const t = setup();
  t.telemetry.track("roll_opened", PUB);
  await t.telemetry.flush();
  const event = t.sent[0]!.body.events[0]!;
  assert.deepEqual(Object.keys(event).sort(), [
    "event_id",
    "kind",
    "occurred_at_ms",
    "publication_id",
    "session_id",
  ]);
  assert.match(String(event["event_id"]), ID);
  assert.match(String(event["session_id"]), SESSION);
  assert.equal(event["kind"], "roll_opened");
  assert.equal(event["publication_id"], PUB);
  assert.equal(event["occurred_at_ms"], t.time);
});

test("events wait for a batch: sent when the batch is full, or five seconds after the first", async () => {
  const t = setup();
  for (let i = 0; i < 9; i++) t.telemetry.track("stage_played", PUB);
  await settle();
  assert.equal(t.sent.length, 0, "nine is not a batch yet");
  t.telemetry.track("stage_played", PUB);
  await settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0]!.body.events.length, 10);

  t.telemetry.track("flip_started", PUB);
  await t.advance(4_900);
  assert.equal(t.sent.length, 1, "not yet");
  await t.advance(200);
  assert.equal(t.sent.length, 2, "five seconds after the first event of the batch");
});

test("leaving the page flushes what is waiting, in a request that outlives the page", async () => {
  const t = setup();
  t.telemetry.track("roll_opened", PUB);
  t.telemetry.pageHide();
  await settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0]!.keepalive, true);
  assert.equal(t.telemetry.queued, 0);
});

test("a failed send is retried a bounded number of times with the same ids, then given up on", async () => {
  const t = setup({ replies: ["throw", { status: 500 }, { status: 500 }, { status: 200 }] });
  t.telemetry.track("roll_opened", PUB);
  await t.telemetry.flush();
  await t.advance(60_000);
  assert.equal(t.sent.length, 3, "the first try and two retries, no more");
  const ids = t.sent.map((s) => s.body.events.map((e) => e["event_id"]).join());
  assert.equal(new Set(ids).size, 1, "every try carries the same event ids, so a repeat dedupes");
  assert.equal(t.telemetry.queued, 0, "then the batch is dropped");
  t.telemetry.track("stage_played", PUB);
  await t.telemetry.flush();
  assert.equal(t.sent.length, 4, "and telemetry still works afterwards");
});

test("the service's kill switch (503) stops sending for the rest of the page load", async () => {
  const t = setup({ replies: [{ status: 503 }] });
  t.telemetry.track("roll_opened", PUB);
  await t.telemetry.flush();
  assert.equal(t.telemetry.stopped, true);
  t.telemetry.track("stage_played", PUB);
  await t.telemetry.flush();
  await t.advance(60_000);
  assert.equal(t.sent.length, 1);
  assert.equal(t.telemetry.queued, 0);
});

test("told to slow down (429), it discards that batch, does not retry, and sends nothing until the time is up", async () => {
  const t = setup({ replies: [{ status: 429, retryAfterSeconds: 30 }] });
  t.telemetry.track("roll_opened", PUB);
  await t.telemetry.flush();
  t.telemetry.track("stage_played", PUB);
  await t.telemetry.flush();
  assert.equal(t.sent.length, 1, "events during the wait are not sent");
  await t.advance(31_000);
  t.telemetry.track("stage_played", PUB);
  await t.telemetry.flush();
  assert.equal(t.sent.length, 2, "after the wait it sends again");
});

test("a batch the service refuses as malformed (422) is dropped, not retried", async () => {
  const t = setup({ replies: [{ status: 422 }] });
  t.telemetry.track("roll_opened", PUB);
  await t.telemetry.flush();
  await t.advance(60_000);
  assert.equal(t.sent.length, 1);
  assert.equal(t.telemetry.queued, 0);
});

test("memory is bounded: with the network down for good, only the newest hundred events are kept", async () => {
  const t = setup({ replies: Array(1000).fill("throw") });
  for (let i = 0; i < 150; i++) t.telemetry.track("stage_played", PUB);
  assert.ok(t.telemetry.queued <= 100, `queued ${t.telemetry.queued}`);
});

test("the session id is the same within a visit, and is new after thirty quiet minutes", async () => {
  const t = setup();
  const idOf = async (): Promise<string> => {
    t.telemetry.track("stage_played", PUB);
    await t.telemetry.flush();
    return String(t.sent.at(-1)!.body.events.at(-1)!["session_id"]);
  };
  const first = await idOf();
  await t.advance(29 * 60_000);
  assert.equal(await idOf(), first, "activity within the window keeps the session");
  await t.advance(29 * 60_000); // 29 minutes since the last event, 58 since the first
  assert.equal(await idOf(), first, "the window slides with activity");
  await t.advance(31 * 60_000);
  assert.notEqual(await idOf(), first, "thirty-one quiet minutes: a new session");
});

test("a network that throws never reaches the caller", async () => {
  const t = setup({ replies: ["throw"] });
  assert.doesNotThrow(() => t.telemetry.track("roll_opened", PUB));
  await assert.doesNotReject(t.telemetry.flush());
  assert.doesNotThrow(() => t.telemetry.pageHide());
});
