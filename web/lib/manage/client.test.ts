// The maker's two actions, sent with the manage key in a header and nowhere else. Every way of being
// refused reads the same, so the page cannot tell a wrong key from a missing publication.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setForkPermission, setNote, withdraw, type Fetcher } from "./client.ts";

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

test("a note goes to the note route as JSON with the key in the header only", async () => {
  const { fetcher, calls } = fake(200, { note: "from the lake", adjusted: false });
  const done = await setNote(fetcher, "http://api.test", "abc123", KEY, "from the lake");
  assert.deepEqual(done, { kind: "saved", note: "from the lake", adjusted: false });
  const call = calls[0]!;
  assert.equal(call.url, "http://api.test/v1/publications/abc123/note");
  assert.equal(call.init.method, "PUT");
  assert.equal(call.init.body, JSON.stringify({ note: "from the lake" }));
  assert.ok(!call.url.includes(KEY) && !String(call.init.body).includes(KEY));
  assert.equal((call.init.headers as Record<string, string>)["x-graft-manage-key"], KEY);
});

test("an emptied note comes back as no note, and a removed link is reported", async () => {
  assert.deepEqual(
    await setNote(fake(200, { note: null, adjusted: false }).fetcher, "http://a", "x", KEY, ""),
    { kind: "saved", note: null, adjusted: false },
  );
  assert.deepEqual(
    await setNote(
      fake(200, { note: "see", adjusted: true }).fetcher,
      "http://a",
      "x",
      KEY,
      "see a.com",
    ),
    { kind: "saved", note: "see", adjusted: true },
  );
});

test("each way a note edit can be turned away is told apart, except the key, which is one answer", async () => {
  const run = (status: number, body: unknown = {}) =>
    setNote(fake(status, body).fetcher, "http://a", "x", KEY, "n");
  assert.deepEqual(await run(403), { kind: "refused" });
  assert.deepEqual(await run(404), { kind: "refused" });
  assert.deepEqual(await run(409, { type: "urn:graft:problem:note-locked" }), { kind: "locked" });
  assert.deepEqual(await run(422, { rule: "too_long", field: "note" }), {
    kind: "invalid",
    rule: "too_long",
  });
  assert.deepEqual(await run(429), { kind: "limited" });
  assert.deepEqual(await run(503, { type: "urn:graft:problem:publishing-off" }), {
    kind: "closed",
  });
  assert.deepEqual(await run(503, { type: "urn:graft:problem:retry-later" }), { kind: "busy" });
  assert.deepEqual(await run(500), { kind: "unreachable" });
  const down: Fetcher = async () => {
    throw new TypeError("failed to fetch");
  };
  assert.deepEqual(await setNote(down, "http://a", "x", KEY, "n"), { kind: "unreachable" });
});

test("a note edit with a key that cannot be a header value sends nothing", async () => {
  const { fetcher, calls } = fake(200);
  assert.deepEqual(await setNote(fetcher, "http://a", "x", "bad\nkey", "n"), { kind: "refused" });
  assert.deepEqual(await setNote(fetcher, "http://a", "x", "", "n"), { kind: "refused" });
  assert.equal(calls.length, 0);
});
