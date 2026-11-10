import { forwardWake, type WakeState } from "../../../lib/wake/forward.ts";

// The browser asks the site's own server; the server forwards one call to the wake function with the
// shared secret (kept only in this server's environment). It always answers at once with nothing in the
// body: no address, no secret, no result, so a browser learns nothing from it.
export const dynamic = "force-dynamic";

const state: WakeState = { last: 0 };

export async function POST(): Promise<Response> {
  const result = await forwardWake(process.env, { fetch, now: Date.now, state });
  if (result === "failed") console.warn("wake: the call did not go through");
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
