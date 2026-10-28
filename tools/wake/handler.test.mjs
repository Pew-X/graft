// The handler against stand-in ECS, tag and metric clients: nothing real is ever called. It pins what the
// outside world can rely on: a wrong or missing secret is refused and does nothing, the right one wakes
// once, a burst is one wake, a failure is reported and not swallowed, and the scheduled check parks only
// when the plan says so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeHandler, sameSecret } from "./handler.mjs";

const now = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;

function world(over = {}) {
  const calls = [];
  const logs = [];
  const state = { desired: 0, warmUntil: null, wokenAt: null, requests: 0, ...over };
  const deps = {
    secret: "s3cret-value",
    now: () => now,
    log: (line) => logs.push(line),
    service: {
      read: async () => ({ desired: state.desired, warmUntil: state.warmUntil, wokenAt: state.wokenAt }),
      scale: async (n) => {
        calls.push(["scale", n]);
        if (state.failScale) throw new Error("ecs said no");
        state.desired = n;
      },
      markWoken: async (t) => {
        calls.push(["woken", t]);
        state.wokenAt = t;
      },
    },
    metrics: { requests: async () => state.requests },
  };
  return { handler: makeHandler(deps), calls, logs, state };
}

const visit = (secret) => ({
  requestContext: { http: { method: "POST" } },
  headers: secret === undefined ? {} : { "x-graft-wake": secret },
});
const tick = { source: "aws.events", "detail-type": "Scheduled Event" };
const body = (r) => JSON.parse(r.body);

test("a wrong or missing secret is refused and nothing is touched", async () => {
  for (const given of [undefined, "", "nope", "s3cret-valuE", "s3cret-value "]) {
    const { handler, calls } = world();
    const r = await handler(visit(given));
    assert.equal(r.statusCode, 401, String(given));
    assert.deepEqual(calls, []);
    assert.deepEqual(body(r), { error: "refused" });
  }
});

test("the refusal is logged without the secret that was tried", async () => {
  const { handler, logs } = world();
  await handler(visit("guess-123"));
  assert.ok(logs.some((l) => /refused/.test(l)));
  assert.ok(logs.every((l) => !l.includes("guess-123") && !l.includes("s3cret-value")));
});

test("the right secret wakes a stopped service to exactly one task, and notes the time", async () => {
  const { handler, calls } = world();
  const r = await handler(visit("s3cret-value"));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(body(r), { state: "waking", acted: true, reason: "stopped" });
  assert.deepEqual(calls, [["scale", 1], ["woken", now]]);
});

test("a visit to a service that is up changes nothing and says so", async () => {
  const { handler, calls } = world({ desired: 1 });
  const r = await handler(visit("s3cret-value"));
  assert.deepEqual(body(r), { state: "up", acted: false, reason: "already up" });
  assert.deepEqual(calls, []);
});

test("a second visit inside the gap does not call the update twice", async () => {
  const { handler, calls } = world({ desired: 0, wokenAt: now - 5_000 });
  const r = await handler(visit("s3cret-value"));
  assert.equal(r.statusCode, 200);
  assert.equal(body(r).state, "waking");
  assert.deepEqual(calls, []);
});

test("an update that fails is reported as a failure, not swallowed, and the time is not noted", async () => {
  const { handler, calls, logs } = world({ failScale: true });
  const r = await handler(visit("s3cret-value"));
  assert.equal(r.statusCode, 502);
  assert.deepEqual(body(r), { error: "could not start" });
  assert.deepEqual(calls, [["scale", 1]]);
  assert.ok(logs.some((l) => /ecs said no/.test(l)));
});

test("the scheduled check parks an idle service and notes why", async () => {
  const { handler, calls, logs } = world({ desired: 1, requests: 0, wokenAt: now - 60 * MIN });
  const r = await handler(tick);
  assert.deepEqual(body(r), { acted: true, reason: "idle" });
  assert.deepEqual(calls, [["scale", 0]]);
  assert.ok(logs.some((l) => /park.*idle/.test(l)));
});

test("the scheduled check leaves a busy, warm, new or unmeasured service alone", async () => {
  const cases = [
    [{ desired: 1, requests: 12 }, "in use"],
    [{ desired: 1, requests: 0, warmUntil: now + MIN }, "warm window"],
    [{ desired: 1, requests: 0, wokenAt: now - 2 * MIN }, "woken recently"],
    [{ desired: 1, requests: null }, "no count to go on"],
    [{ desired: 0 }, "already stopped"],
  ];
  for (const [facts, reason] of cases) {
    const { handler, calls } = world(facts);
    const r = await handler(tick);
    assert.deepEqual(body(r), { acted: false, reason }, reason);
    assert.deepEqual(calls, [], reason);
  }
});

test("a visit cannot make the scheduled check run, and a schedule cannot pass for a visit", async () => {
  const { handler, calls } = world({ desired: 1, requests: 0 });
  // a web request that claims to be the schedule is still a web request: it needs the secret
  const forged = { requestContext: { http: { method: "POST" } }, headers: {}, ...tick };
  assert.equal((await handler(forged)).statusCode, 401);
  // anything that is neither is refused
  assert.equal((await handler({ hello: "world" })).statusCode, 401);
  assert.deepEqual(calls, []);
});

test("the secret is compared in constant time, whatever the lengths", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", ""), false, "an empty secret never matches");
  assert.equal(sameSecret(undefined, "abc"), false);
});

test("the comparison goes through timingSafeEqual, never == or ===, so its time does not show how much matched", () => {
  const source = readFileSync(new URL("./handler.mjs", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual\(/);
  assert.doesNotMatch(source, /(given|secret)\s*===?\s*(given|wanted|secret)/);
});
