// The wake and park decisions, worked by hand. The function that carries them out holds no logic of its
// own, so everything that decides "start it", "stop it" or "leave it" is checked here, with numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_WINDOW_MS, MIN_UP_MS, WAKE_GAP_MS, shouldPark, shouldWake } from "./decide.mjs";

const MIN = 60_000;
const now = Date.UTC(2026, 10, 1, 12, 0, 0);
const base = { desired: 1, now, lastWakeAt: null, warmUntil: null, requests: 0 };

test("a visit to a service that is stopped wakes it, once", () => {
  assert.deepEqual(shouldWake({ desired: 0, now, lastWakeAt: null }), { act: true, reason: "stopped" });
});

test("a visit to a service that is already up does nothing, and says so", () => {
  assert.deepEqual(shouldWake({ desired: 1, now, lastWakeAt: null }), { act: false, reason: "already up" });
});

test("it is never asked for more than one task", () => {
  // anything the service reports at or above one is "up"; there is no path that asks for two
  for (const desired of [1, 2, 5]) assert.equal(shouldWake({ desired, now, lastWakeAt: null }).act, false);
});

test("a burst of visits is one wake: a second call inside the gap does not call the update again", () => {
  const first = now - (WAKE_GAP_MS - 1);
  assert.deepEqual(shouldWake({ desired: 0, now, lastWakeAt: first }), { act: false, reason: "woken a moment ago" });
  assert.equal(shouldWake({ desired: 0, now, lastWakeAt: now - WAKE_GAP_MS }).act, true);
});

test("an idle service with no warm window, up long enough, is parked", () => {
  assert.deepEqual(shouldPark({ ...base, lastWakeAt: now - MIN_UP_MS - MIN }), { act: true, reason: "idle" });
  assert.deepEqual(shouldPark(base), { act: true, reason: "idle" });
});

test("a service that is already stopped is left alone", () => {
  assert.deepEqual(shouldPark({ ...base, desired: 0 }), { act: false, reason: "already stopped" });
});

test("it is not parked while there is a warm window, and is parked once the window has passed", () => {
  assert.deepEqual(shouldPark({ ...base, warmUntil: now + MIN }), { act: false, reason: "warm window" });
  assert.deepEqual(shouldPark({ ...base, warmUntil: now }), { act: true, reason: "idle" });
  assert.deepEqual(shouldPark({ ...base, warmUntil: now - 1 }), { act: true, reason: "idle" });
});

test("any request in the idle window means it is in use", () => {
  assert.deepEqual(shouldPark({ ...base, requests: 1 }), { act: false, reason: "in use" });
  assert.deepEqual(shouldPark({ ...base, requests: 400 }), { act: false, reason: "in use" });
});

test("a count that is missing, late or odd never parks a service: no data is not idle", () => {
  for (const requests of [null, undefined, Number.NaN, -1]) {
    assert.deepEqual(shouldPark({ ...base, requests }), { act: false, reason: "no count to go on" });
  }
});

test("a service just woken is not parked on a count that has not caught up", () => {
  // CloudWatch lags a few minutes: right after a wake the window can read zero for a while
  assert.deepEqual(shouldPark({ ...base, lastWakeAt: now - (MIN_UP_MS - 1) }), { act: false, reason: "woken recently" });
  assert.equal(shouldPark({ ...base, lastWakeAt: now - MIN_UP_MS }).act, true);
});

test("the warm window outranks everything else, and a stopped service outranks the warm window", () => {
  assert.equal(shouldPark({ ...base, requests: 0, warmUntil: now + 1 }).reason, "warm window");
  assert.equal(shouldPark({ ...base, desired: 0, warmUntil: now + 1 }).reason, "already stopped");
});

test("the windows are the ones the plan names: idle 30 minutes, up at least 20, wake gap 60 seconds", () => {
  assert.equal(IDLE_WINDOW_MS, 30 * MIN);
  assert.equal(MIN_UP_MS, 20 * MIN);
  assert.equal(WAKE_GAP_MS, 60_000);
});
