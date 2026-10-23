// The maker's two actions, sent with the manage key in a header and nowhere else. Every way of being
// refused reads the same, so the page cannot tell a wrong key from a missing publication.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setForkPermission, withdraw, type Fetcher } from "./client.ts";

const KEY = "a-very-secret-manage-key-0123456789abcdefABCDEF";
function fake(
  status: number,
  body: unknown = {},
): { fetcher: Fetcher; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetcher, calls };
}

test("the key goes in the X-Graft-Manage-Key header only: never in the address or the body", async () => {
  const { fetcher, calls } = fake(200, { fork_permitted: false, withdrawn: false });
  await setForkPermission(fetcher, "http://api.test", "abc123", KEY, false);
  await withdraw(fetcher, "http://api.test", "abc123", KEY);
  for (const { url, init } of calls) {
    assert.ok(!url.includes(KEY), url);
    assert.ok(!String(init.body ?? "").includes(KEY));
    assert.equal((init.headers as Record<string, string>)["x-graft-manage-key"], KEY);
  }
  assert.equal(calls[0]!.url, "http://api.test/v1/publications/abc123/fork-permission");
  assert.equal(calls[0]!.init.method, "PUT");
  assert.equal(calls[0]!.init.body, JSON.stringify({ permitted: false }));
  assert.equal(calls[1]!.url, "http://api.test/v1/publications/abc123/withdraw");
  assert.equal(calls[1]!.init.method, "POST");
});

test("an accepted action returns the stage as it now is", async () => {
  const closed = await setForkPermission(
    fake(200, { fork_permitted: false, withdrawn: false }).fetcher,
    "http://a",
    "x",
    KEY,
    false,
  );
  assert.deepEqual(closed, { kind: "done", forkPermitted: false, withdrawn: false });
  const gone = await withdraw(
    fake(200, { fork_permitted: true, withdrawn: true }).fetcher,
    "http://a",
    "x",
    KEY,
  );
  assert.deepEqual(gone, { kind: "done", forkPermitted: true, withdrawn: true });
});

test("a refusal is one answer whatever the reason: 403 and 404 are the same", async () => {
  const a = await withdraw(
    fake(403, { type: "urn:graft:problem:manage-key-refused" }).fetcher,
    "http://a",
    "x",
    KEY,
  );
  const b = await withdraw(fake(404, {}).fetcher, "http://a", "x", KEY);
  assert.deepEqual(a, { kind: "refused" });
  assert.deepEqual(b, { kind: "refused" });
});

test("busy and unreachable are told apart from refused, so a retry is offered only where it can help", async () => {
  assert.deepEqual(await withdraw(fake(503).fetcher, "http://a", "x", KEY), { kind: "busy" });
  const down: Fetcher = async () => {
    throw new TypeError("failed to fetch");
  };
  assert.deepEqual(await withdraw(down, "http://a", "x", KEY), { kind: "unreachable" });
  assert.deepEqual(await withdraw(fake(500).fetcher, "http://a", "x", KEY), {
    kind: "unreachable",
  });
});

test("a key that cannot be a header value is refused before anything is sent", async () => {
  const { fetcher, calls } = fake(200);
  assert.deepEqual(await withdraw(fetcher, "http://a", "x", "has a\nnewline"), { kind: "refused" });
  assert.deepEqual(await withdraw(fetcher, "http://a", "x", ""), { kind: "refused" });
  assert.equal(calls.length, 0);
});
