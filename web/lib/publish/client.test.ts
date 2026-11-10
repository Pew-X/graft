// Publishing never makes a duplicate or a loss: the same key is sent on every retry, retries are
// bounded, and every refusal the service can give is told apart. The network is a fake that
// scripts what each attempt meets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publishWithRetries, refusalFrom, type Wire, type WireResult } from "./client.ts";

const body = {
  parent_id: "abc",
  retry_key: "web-0123456789abcdef",
  title: "t",
  author: "a",
} as never;
const problem = (
  type: string,
  status: number,
  extra: Record<string, unknown> = {},
): WireResult => ({
  status,
  body: { type: `urn:graft:problem:${type}`, title: "x", status, detail: "d", ...extra },
});
const created = (status = 201): WireResult => ({
  status,
  body: {
    publication: { id: "newid1234567" },
    manage_key: status === 201 ? "k".repeat(43) : null,
    adjusted_fields: [],
    preview_matches: true,
  },
});

function script(...steps: Array<WireResult | "network">): { wire: Wire; sent: unknown[] } {
  const sent: unknown[] = [];
  let i = 0;
  const wire: Wire = {
    async post(b) {
      sent.push(b);
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if (step === "network") throw new TypeError("failed to fetch");
      return step;
    },
  };
  return { wire, sent };
}
const options = (delays: number[] = [10, 20, 40]) => {
  const waited: number[] = [];
  return {
    waited,
    opts: { delays, sleep: async (ms: number) => void waited.push(ms) },
  };
};

test("a first-time publish is reported as created, with the manage key it came with", async () => {
  const { wire } = script(created());
  const out = await publishWithRetries(wire, body, options().opts);
  assert.equal(out.kind, "published");
  if (out.kind !== "published") return;
  assert.equal(out.created, true);
  assert.equal(out.id, "newid1234567");
  assert.equal(out.manageKey?.length, 43);
  assert.equal(out.previewMatches, true);
});

test("a replay of the same request is reported as not created, with no manage key", async () => {
  const { wire } = script(created(200));
  const out = await publishWithRetries(wire, body, options().opts);
  assert.ok(out.kind === "published" && !out.created && out.manageKey === null);
});

test("a network failure after the request was sent is retried with the same body, key included", async () => {
  const { wire, sent } = script("network", "network", created());
  const { opts, waited } = options();
  const out = await publishWithRetries(wire, body, opts);
  assert.equal(out.kind, "published");
  assert.equal(sent.length, 3);
  assert.ok(
    sent.every((s) => s === body),
    "the same request every time",
  );
  assert.deepEqual(waited, [10, 20], "bounded backoff between attempts");
});

test("the service's retry-later answer is retried with the same key until it works", async () => {
  const { wire, sent } = script(problem("retry-later", 503), created());
  const out = await publishWithRetries(wire, body, options().opts);
  assert.equal(out.kind, "published");
  assert.equal(sent.length, 2);
});

test("when every automatic attempt fails, it gives up and says how many it made and why", async () => {
  const { wire, sent } = script(problem("retry-later", 503));
  const { opts } = options([5, 5, 5]);
  const out = await publishWithRetries(wire, body, opts);
  assert.deepEqual(out, { kind: "gaveUp", attempts: 4, why: "busy" });
  assert.equal(sent.length, 4, "the first try and three retries, never more");
  const offline = await publishWithRetries(script("network").wire, body, options([1]).opts);
  assert.deepEqual(offline, { kind: "gaveUp", attempts: 2, why: "network" });
});

test("a refusal is final: nothing is retried automatically and the reason is kept", async () => {
  const { wire, sent } = script(problem("publishing-off", 503));
  const out = await publishWithRetries(wire, body, options().opts);
  assert.equal(out.kind, "refused");
  assert.equal(sent.length, 1);
});

test("an answer that says published but names no publication is not believed", async () => {
  const html: WireResult = { status: 200, body: null };
  const out = await publishWithRetries(script(html).wire, body, options().opts);
  assert.deepEqual(out, { kind: "refused", refusal: { kind: "internal" } });
  const noId: WireResult = { status: 201, body: { publication: {}, manage_key: "k" } };
  assert.deepEqual(await publishWithRetries(script(noId).wire, body, options().opts), {
    kind: "refused",
    refusal: { kind: "internal" },
  });
});

test("a switched-off upload door is a refusal, not a busy service: nothing is retried", async () => {
  const { wire, sent } = script(problem("uploads-off", 503));
  const out = await publishWithRetries(wire, body, options().opts);
  assert.deepEqual(out, { kind: "refused", refusal: { kind: "uploadsOff" } });
  assert.equal(sent.length, 1);
});

test("progress is reported before each attempt, so the page can say it is trying again", async () => {
  const { wire } = script("network", created());
  const seen: Array<[number, number]> = [];
  await publishWithRetries(wire, body, {
    ...options().opts,
    onAttempt: (n, of) => seen.push([n, of]),
  });
  assert.deepEqual(seen, [
    [1, 4],
    [2, 4],
  ]);
});

test("a cancelled wait stops the retrying instead of publishing later", async () => {
  const { wire, sent } = script("network", created());
  const controller = new AbortController();
  const out = await publishWithRetries(wire, body, {
    delays: [10],
    sleep: async () => controller.abort(),
    signal: controller.signal,
  });
  assert.equal(out.kind, "cancelled");
  assert.equal(sent.length, 1);
});

test("each problem the service gives maps to its own refusal, with the numbers a person needs", () => {
  const of = (type: string, status: number, extra?: Record<string, unknown>) =>
    refusalFrom(problem(type, status, extra));
  assert.equal(of("publishing-off", 503).kind, "publishingOff");
  assert.equal(of("storage-full", 507).kind, "storageFull");
  assert.equal(of("uploads-off", 503).kind, "uploadsOff");
  assert.deepEqual(of("rate-limited", 429, { retry_after_secs: 90 }), {
    kind: "rateLimited",
    retryAfterSecs: 90,
  });
  assert.deepEqual(of("publish-cap", 429, { retry_after_secs: 600 }), {
    kind: "publishCap",
    retryAfterSecs: 600,
  });
  assert.equal(of("fork-cap", 429, { retry_after_secs: 60 }).kind, "forkCap");
  assert.equal(of("fork-not-permitted", 403).kind, "forkClosed");
  assert.equal(of("depth-cap", 409).kind, "depthCap");
  assert.equal(of("parent-held", 409).kind, "parentHeld");
  assert.equal(of("parent-unavailable", 409).kind, "parentGone");
  assert.equal(of("not-found", 404).kind, "parentGone");
  assert.equal(of("key-conflict", 409).kind, "conflict");
  assert.deepEqual(of("invalid-field", 422, { field: "title", rule: "denied_word" }), {
    kind: "invalid",
    field: "title",
    rule: "denied_word",
  });
  assert.equal(of("internal", 500).kind, "internal");
  assert.equal(of("too-large", 413).kind, "internal");
  assert.equal(
    refusalFrom({ status: 418, body: "teapot" }).kind,
    "internal",
    "an unreadable answer is not blamed on the maker",
  );
});
