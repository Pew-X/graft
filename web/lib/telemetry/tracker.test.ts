import assert from "node:assert/strict";
import { test } from "node:test";
import { startErrorTracking } from "./tracker.ts";

test("with a privacy signal on, the error tracker's code is never even loaded", async () => {
  let loaded = 0;
  const started = await startErrorTracking({
    gated: true,
    dsn: "https://key@tracker/1",
    load: async () => {
      loaded += 1;
      return { init() {} };
    },
  });
  assert.equal(started, false);
  assert.equal(loaded, 0);
});

test("with no tracker configured, nothing is loaded either", async () => {
  let loaded = 0;
  const load = async () => {
    loaded += 1;
    return { init() {} };
  };
  assert.equal(await startErrorTracking({ gated: false, dsn: undefined, load }), false);
  assert.equal(await startErrorTracking({ gated: false, dsn: "", load }), false);
  assert.equal(await startErrorTracking({ gated: false, dsn: "https://k@t/1" }), false);
  assert.equal(loaded, 0);
});

test("when allowed it starts with no address stored, no replay, no default integrations and a scrubber", async () => {
  let options: Record<string, unknown> = {};
  const started = await startErrorTracking({
    gated: false,
    dsn: "https://key@tracker/1",
    load: async () => ({
      init(o) {
        options = o as unknown as Record<string, unknown>;
      },
    }),
  });
  assert.equal(started, true);
  assert.equal(options["sendDefaultPii"], false);
  assert.equal(options["replaysSessionSampleRate"], 0);
  assert.equal(options["replaysOnErrorSampleRate"], 0);
  assert.equal(options["defaultIntegrations"], false);
  assert.equal(options["maxBreadcrumbs"], 0);
  const scrub = options["beforeSend"] as (e: Record<string, unknown>) => Record<string, unknown>;
  const clean = scrub({
    message: "boom",
    user: { ip_address: "203.0.113.9", id: "x" },
    request: { url: "https://x.example.test/p/abc", cookies: "a=b", headers: { cookie: "a=b" } },
    contexts: { device: { name: "d" } },
  });
  assert.equal(clean["user"], undefined);
  assert.deepEqual(clean["request"], { url: "https://x.example.test/p/abc" });
  assert.equal(clean["message"], "boom");
});

test("a tracker that fails to load never breaks the page", async () => {
  const started = await startErrorTracking({
    gated: false,
    dsn: "https://key@tracker/1",
    load: async () => {
      throw new Error("blocked by an extension");
    },
  });
  assert.equal(started, false);
});
