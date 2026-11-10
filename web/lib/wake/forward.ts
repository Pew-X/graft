/**
 * The site's side of waking the service. The browser asks the site's own server, and the server forwards
 * one call to the wake function with the shared secret, so the function's address and the secret never
 * reach a browser. It answers at once whatever happens (a refusal, an error, a function that hangs), and
 * it carries nothing about the visitor: no body, no address, no identifier. Without its two settings it
 * does nothing, so the site behaves as it did before they were set.
 */
export interface WakeState {
  /** When a call was last sent, in milliseconds; 0 for never. */
  last: number;
}

export type WakeResult = "inert" | "throttled" | "sent" | "failed";

/** Calls closer together than this are one: the function itself also treats them as one. */
const MIN_GAP_MS = 60_000;
/** The longest the route waits for the function. */
const DEFAULT_TIMEOUT_MS = 3_000;

export async function forwardWake(
  env: Record<string, string | undefined>,
  deps: {
    fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
    now: () => number;
    state: WakeState;
    timeoutMs?: number;
  },
): Promise<WakeResult> {
  const url = env["GRAFT_WAKE_URL"]?.trim();
  const secret = env["GRAFT_WAKE_SECRET"]?.trim();
  if (!url || !secret) return "inert";
  const at = deps.now();
  if (deps.state.last !== 0 && at - deps.state.last < MIN_GAP_MS) return "throttled";
  try {
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { "x-graft-wake": secret },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return "failed";
    // only a call that went through starts the minute, so a failure never blocks the next try
    deps.state.last = at;
    return "sent";
  } catch {
    return "failed";
  }
}
