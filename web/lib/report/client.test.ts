import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES, NOTE_MAX, sendReport, type Fetcher } from "./client.ts";

function fake(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetcher, calls };
}

test("the categories are the service's five, in an order a person would look for them", () => {
  assert.deepEqual(CATEGORIES, ["rights", "private_conversation", "harmful", "spam", "other"]);
  assert.equal(NOTE_MAX, 500);
});

test("a report sends the publication, the category and the note, and nothing that identifies the sender", async () => {
  const { fetcher, calls } = fake(201, { received: true });
  const out = await sendReport(fetcher, "http://api.test", {
    id: "abc",
    category: "rights",
    note: " it is mine ",
  });
  assert.deepEqual(out, { kind: "sent" });
  assert.equal(calls[0]!.url, "http://api.test/v1/reports");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    publication_id: "abc",
    category: "rights",
    note: "it is mine",
  });
  assert.equal(
    calls[0]!.init.credentials,
    "omit",
    "no cookies or other credentials travel with it",
  );
});

test("an empty note is left out rather than sent as an empty string", async () => {
  const { fetcher, calls } = fake(201);
  await sendReport(fetcher, "http://a", { id: "abc", category: "spam", note: "   " });
  assert.ok(!("note" in JSON.parse(String(calls[0]!.init.body))));
});

test("each refusal is told apart: rate limited with when, gone, a note that breaks a rule, unreachable", async () => {
  const p = (type: string, status: number, extra: object = {}) =>
    fake(status, { type: `urn:graft:problem:${type}`, status, ...extra });
  const send = (f: ReturnType<typeof fake>) =>
    sendReport(f.fetcher, "http://a", { id: "x", category: "other", note: "" });
  assert.deepEqual(await send(p("rate-limited", 429, { retry_after_secs: 90 })), {
    kind: "rateLimited",
    retryAfterSecs: 90,
  });
  assert.deepEqual(await send(p("not-found", 404)), { kind: "gone" });
  assert.deepEqual(await send(p("invalid-field", 422, { field: "note", rule: "character" })), {
    kind: "invalid",
    rule: "character",
  });
  assert.deepEqual(await send(p("retry-later", 503)), { kind: "unreachable" });
  assert.deepEqual(await send(fake(500)), { kind: "unreachable" });
  const down: Fetcher = async () => {
    throw new TypeError("failed");
  };
  assert.deepEqual(await sendReport(down, "http://a", { id: "x", category: "other", note: "" }), {
    kind: "unreachable",
  });
});
