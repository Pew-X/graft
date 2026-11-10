// The site's side of waking the service: it forwards one call to the wake function with the shared secret,
// which lives only in the server's environment. What a visitor's browser can ever learn from it is nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardWake, type WakeState } from "./forward.ts";

const env = { GRAFT_WAKE_URL: "https://wake.example.test/", GRAFT_WAKE_SECRET: "s3cret-value" };
const calls: Array<{ url: string; init: RequestInit }> = [];
const fakeFetch =
  (reply: () => Promise<Response> | Response) =>
  async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  };
const fresh = (): WakeState => ({ last: 0 });
const NOW = 1_000_000;

test("without its settings it does nothing at all", async () => {
  calls.length = 0;
  for (const e of [
    {},
    { GRAFT_WAKE_URL: "https://x.test/" },
    { GRAFT_WAKE_SECRET: "s" },
    { GRAFT_WAKE_URL: "", GRAFT_WAKE_SECRET: "" },
  ]) {
    assert.equal(
      await forwardWake(e, {
        fetch: fakeFetch(() => new Response("{}")),
        now: () => NOW,
        state: fresh(),
      }),
      "inert",
    );
  }
  assert.equal(calls.length, 0);
});

test("with its settings it posts once to the function with the secret in a header, and the secret nowhere else", async () => {
  calls.length = 0;
  const r = await forwardWake(env, {
    fetch: fakeFetch(() => new Response('{"state":"waking"}')),
    now: () => NOW,
    state: fresh(),
  });
  assert.equal(r, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://wake.example.test/");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-graft-wake"], "s3cret-value");
  assert.ok(!calls[0]!.url.includes("s3cret-value"), "never in the address");
  assert.equal(
    calls[0]!.init.body,
    undefined,
    "and no body: the call carries nothing about the visitor",
  );
});

test("a burst of calls is one: a second call inside a minute is not forwarded, and one after it is", async () => {
  calls.length = 0;
  const state = fresh();
  const send = (t: number) =>
    forwardWake(env, { fetch: fakeFetch(() => new Response("{}")), now: () => t, state });
  assert.equal(await send(NOW), "sent");
  assert.equal(await send(NOW + 59_000), "throttled");
  assert.equal(await send(NOW + 60_000), "sent");
  assert.equal(calls.length, 2);
});

test("a function that errors, refuses or throws is swallowed: the visitor is never told", async () => {
  for (const reply of [
    () => new Response("no", { status: 401 }),
    () => new Response("no", { status: 502 }),
    () => {
      throw new Error("boom");
    },
  ]) {
    const r = await forwardWake(env, {
      fetch: fakeFetch(reply as never),
      now: () => NOW,
      state: fresh(),
    });
    assert.equal(r, "failed");
  }
});

test("a function that hangs is cut off within the bound, so the route answers quickly", async () => {
  const hang = (_u: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  const started = Date.now();
  const r = await forwardWake(env, { fetch: hang, now: () => NOW, state: fresh(), timeoutMs: 50 });
  assert.equal(r, "failed");
  assert.ok(Date.now() - started < 1000);
});

test("a throttled or failed attempt leaves the next attempt free: only a sent call starts the minute", async () => {
  const state = fresh();
  await forwardWake(env, {
    fetch: fakeFetch(() => {
      throw new Error("down");
    }),
    now: () => NOW,
    state,
  });
  assert.equal(
    await forwardWake(env, {
      fetch: fakeFetch(() => new Response("{}")),
      now: () => NOW + 1000,
      state,
    }),
    "sent",
  );
});
