import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminClient, Refused, ageText, hourText } from "./api.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function client(reply: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body as string | undefined,
    };
    calls.push(call);
    const r = reply(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return {
    admin: new AdminClient("https://api.example.test/", "the-operator-secret-0123456789", fetcher),
    calls,
  };
}

test("the secret travels in a header and nowhere else", async () => {
  const { admin, calls } = client(() => ({
    status: 200,
    body: { publishing: true, uploads: false },
  }));
  await admin.switchView();
  await admin.setPublishing(false);
  const call = calls[0]!;
  assert.equal(call.headers["x-graft-admin-secret"], "the-operator-secret-0123456789");
  for (const c of calls) {
    assert.ok(!c.url.includes("the-operator-secret"), "never in an address");
    assert.ok(!(c.body ?? "").includes("the-operator-secret"), "never in a body");
  }
  assert.equal(
    calls[0]!.url,
    "https://api.example.test/admin/switch",
    "a trailing slash on the base is ignored",
  );
});

test("every refusal of the secret is the same, whatever the status", async () => {
  for (const status of [401, 403, 429]) {
    const { admin } = client(() => ({ status }));
    await assert.rejects(admin.switchView(), (e) => e instanceof Refused, `status ${status}`);
  }
});

test("a service that fails is an error of its own, not a refusal of the secret", async () => {
  const { admin } = client(() => ({ status: 500 }));
  await assert.rejects(admin.switchView(), (e) => e instanceof Error && !(e instanceof Refused));
});

test("hide and lift use the routes the service has, with the reason in the body", async () => {
  const { admin, calls } = client(() => ({
    status: 200,
    body: { id: "x", hidden: "rights", fork_permitted: true },
  }));
  await admin.hide("pub123", "rights");
  await admin.lift("pub123");
  assert.deepEqual(
    calls.map((c) => [c.method, new URL(c.url).pathname, c.body]),
    [
      ["POST", "/admin/publications/pub123/hide", JSON.stringify({ reason: "rights" })],
      ["DELETE", "/admin/publications/pub123/hide", undefined],
    ],
  );
});

test("a publication id is encoded into the address, so it cannot change the route", async () => {
  const { admin, calls } = client(() => ({ status: 200, body: {} }));
  await admin.hide("../switch?x=1", "withdrawn");
  assert.equal(new URL(calls[0]!.url).pathname, "/admin/publications/..%2Fswitch%3Fx%3D1/hide");
});

test("ages and hours are written plainly and the same everywhere", () => {
  assert.equal(ageText(0), "none waiting");
  assert.equal(ageText(850), "under a second");
  assert.equal(ageText(42_000), "42 seconds");
  assert.equal(ageText(125_000), "2 minutes");
  assert.equal(ageText(7_300_000), "2 hours");
  assert.equal(hourText(Date.UTC(2026, 9, 23, 14, 0, 0)), "2026-10-23 14:00 utc");
});
