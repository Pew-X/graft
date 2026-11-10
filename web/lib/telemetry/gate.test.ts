import assert from "node:assert/strict";
import { test } from "node:test";
import { privacySignalled } from "./gate.ts";

test("Global Privacy Control switches telemetry off", () => {
  assert.equal(privacySignalled({ globalPrivacyControl: true }), true);
});

test("Do Not Track, in each spelling browsers have used, switches telemetry off", () => {
  assert.equal(privacySignalled({ doNotTrack: "1" }), true);
  assert.equal(privacySignalled({ doNotTrack: "yes" }), true);
  assert.equal(privacySignalled({ msDoNotTrack: "1" }), true);
  assert.equal(privacySignalled({}, { doNotTrack: "1" }), true);
});

test("both together, of course, still mean off", () => {
  assert.equal(privacySignalled({ globalPrivacyControl: true, doNotTrack: "1" }), true);
});

test("no signal, a refusal of the signal, or a browser that does not say, leaves telemetry on", () => {
  assert.equal(privacySignalled({}), false);
  assert.equal(privacySignalled({ doNotTrack: "0" }), false);
  assert.equal(privacySignalled({ doNotTrack: "unspecified" }), false);
  assert.equal(privacySignalled({ doNotTrack: null }), false);
  assert.equal(privacySignalled({ globalPrivacyControl: false }), false);
});

test("a browser object that throws when read is treated as signalling, the safe side", () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("no");
      },
    },
  );
  assert.equal(privacySignalled(hostile as never), true);
});
