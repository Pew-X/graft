// The wake and park decisions as plain functions: numbers in, a verdict and its reason out. The function
// that runs on AWS only reads the facts, calls these, and carries out the answer.

/** How long without a request before the service counts as idle. */
export const IDLE_WINDOW_MS = 30 * 60_000;
/** A service just woken stays up at least this long, whatever the count says (the count lags a few minutes). */
export const MIN_UP_MS = 20 * 60_000;
/** Visits closer together than this are one wake. */
export const WAKE_GAP_MS = 60_000;

/**
 * A visit: start the service if it is stopped. It is never asked for more than one task, and a second
 * visit a moment after the first does not call the update again.
 * @param {{ desired: number, now: number, lastWakeAt: number | null }} facts
 */
export function shouldWake({ desired, now, lastWakeAt }) {
  if (desired >= 1) return { act: false, reason: "already up" };
  if (lastWakeAt !== null && now - lastWakeAt < WAKE_GAP_MS) {
    return { act: false, reason: "woken a moment ago" };
  }
  return { act: true, reason: "stopped" };
}

/**
 * The scheduled check: stop the service when nobody has used it for the idle window, nothing is keeping
 * it warm, and it has been up long enough. A count that could not be read (the call failed) is never read as idle; a load balancer with no traffic
 * reports nothing, and the function turns that into zero before it gets here.
 * @param {{ desired: number, now: number, lastWakeAt: number | null, warmUntil: number | null, requests: number | null | undefined }} facts
 */
export function shouldPark({ desired, now, lastWakeAt, warmUntil, requests }) {
  if (desired < 1) return { act: false, reason: "already stopped" };
  if (warmUntil !== null && now < warmUntil) return { act: false, reason: "warm window" };
  if (lastWakeAt !== null && now - lastWakeAt < MIN_UP_MS) return { act: false, reason: "woken recently" };
  if (typeof requests !== "number" || !Number.isFinite(requests) || requests < 0) {
    return { act: false, reason: "no count to go on" };
  }
  if (requests > 0) return { act: false, reason: "in use" };
  return { act: true, reason: "idle" };
}
