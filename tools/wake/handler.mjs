// The function that runs on AWS: a visit wakes the service, a schedule parks it when idle. It reads the
// facts, asks decide.mjs what to do, and carries it out. It stores nothing about visitors: no address, no
// identifier. Every action is logged with its reason, and the shared secret is never logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { IDLE_WINDOW_MS, shouldPark, shouldWake } from "./decide.mjs";

/** Compare two secrets without leaking, by length or by position, how much of one matched. */
export function sameSecret(given, wanted) {
  if (typeof given !== "string" || typeof wanted !== "string" || wanted === "") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(wanted).digest();
  return timingSafeEqual(a, b);
}

const reply = (statusCode, payload) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(payload),
});

/**
 * @param {{
 *   secret: string,
 *   now: () => number,
 *   log: (line: string) => void,
 *   service: {
 *     read: () => Promise<{ desired: number, warmUntil: number | null, wokenAt: number | null }>,
 *     scale: (tasks: 0 | 1) => Promise<void>,
 *     markWoken: (at: number) => Promise<void>,
 *   },
 *   metrics: { requests: (windowMs: number) => Promise<number | null> },
 * }} deps
 */
export function makeHandler({ secret, now, log, service, metrics }) {
  async function visit(event) {
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (!sameSecret(headers["x-graft-wake"], secret)) {
      log("refused: a call without the right secret");
      return reply(401, { error: "refused" });
    }
    const at = now();
    const facts = await service.read();
    const verdict = shouldWake({ desired: facts.desired, now: at, lastWakeAt: facts.wokenAt });
    if (!verdict.act) {
      // up, or woken a moment ago: either way it is on its way
      const state = facts.desired >= 1 ? "up" : "waking";
      log(`visit: nothing to do (${verdict.reason})`);
      return reply(200, { state, acted: false, reason: verdict.reason });
    }
    try {
      await service.scale(1);
    } catch (error) {
      log(`visit: could not start: ${error instanceof Error ? error.message : String(error)}`);
      return reply(502, { error: "could not start" });
    }
    await service.markWoken(at).catch((error) => {
      log(`visit: started, but could not note the time: ${error instanceof Error ? error.message : String(error)}`);
    });
    log(`wake: started (${verdict.reason})`);
    return reply(200, { state: "waking", acted: true, reason: verdict.reason });
  }

  async function check() {
    const at = now();
    const facts = await service.read();
    // no need to ask for the count of a service that is stopped
    const requests = facts.desired >= 1 ? await metrics.requests(IDLE_WINDOW_MS).catch(() => null) : null;
    const verdict = shouldPark({
      desired: facts.desired,
      now: at,
      lastWakeAt: facts.wokenAt,
      warmUntil: facts.warmUntil,
      requests,
    });
    if (verdict.act) {
      await service.scale(0);
      log(`park: stopped (${verdict.reason})`);
    } else {
      log(`park check: left alone (${verdict.reason})`);
    }
    return reply(200, { acted: verdict.act, reason: verdict.reason });
  }

  return async function handler(event) {
    try {
      // a web request carries a request context; a schedule does not, and cannot be asked for by one
      if (event?.requestContext?.http) return await visit(event);
      if (event?.source === "aws.events" && event["detail-type"] === "Scheduled Event") return await check();
      log("refused: an event that is neither a visit nor the schedule");
      return reply(401, { error: "refused" });
    } catch (error) {
      log(`failed: ${error instanceof Error ? error.message : String(error)}`);
      return reply(500, { error: "failed" });
    }
  };
}
