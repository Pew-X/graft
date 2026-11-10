/** The real browser under the telemetry core: ids from the crypto source, a keepalive fetch, page-hide hooks. */
import { privacySignalled } from "./gate.ts";
import { Telemetry, type Reply } from "./telemetry.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function random(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join("");
}

async function post(url: string, body: string, keepalive: boolean): Promise<Reply> {
  const response = await fetch(url, {
    method: "POST",
    // The body is JSON, sent as text/plain: that is the one type a cross-origin request may use
    // without a preflight, and a preflight cannot finish while a page is unloading.
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body,
    keepalive,
    // No cookies, no referrer: a request that carries only the batch.
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const retry = Number(response.headers.get("retry-after"));
  return Number.isFinite(retry) && retry > 0
    ? { status: response.status, retryAfterSeconds: retry }
    : { status: response.status };
}

export interface Started {
  telemetry: Telemetry;
  /** Remove the page-hide listeners. */
  dispose: () => void;
}

/**
 * Start reporting to `endpoint`, or return null when there is nowhere to report to. With a privacy
 * signal on it returns a telemetry object that does nothing, and attaches nothing to the page.
 */
export function startTelemetry(endpoint: string | undefined): Started | null {
  if (!endpoint) return null;
  const gated = privacySignalled(navigator, window as unknown as { doNotTrack?: string | null });
  const telemetry = new Telemetry({
    endpoint,
    gated,
    now: () => Date.now(),
    random,
    post,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  });
  if (gated) return { telemetry, dispose: () => undefined };
  const onHide = (): void => {
    if (document.visibilityState === "hidden") telemetry.pageHide();
  };
  const onPageHide = (): void => telemetry.pageHide();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);
  return {
    telemetry,
    dispose: () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
}
