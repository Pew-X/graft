/**
 * Publishing a flip, with the guarantees a flaky network needs. The same request, retry key
 * included, is sent on every attempt, so an answer lost on the way back means a replay of the same
 * publication and never a second one. Automatic retries are few and bounded; after them the page
 * offers a manual retry with the same key. A refusal from the service is final and kept apart by kind.
 */
import type { components } from "../api/schema.d.ts";

export type PublishBody = components["schemas"]["PublishFlipRequest"];
export type PublishSourceBody = components["schemas"]["PublishSourceRequest"];

/** What came back: a status and a parsed body. A failure to get any answer throws instead. */
export interface WireResult {
  status: number;
  body: unknown;
}
export interface Wire {
  post(body: PublishBody | PublishSourceBody): Promise<WireResult>;
}

export type Refusal =
  | {
      kind:
        | "publishingOff"
        | "uploadsOff"
        | "storageFull"
        | "forkClosed"
        | "depthCap"
        | "parentHeld"
        | "parentGone"
        | "conflict"
        | "internal";
    }
  | { kind: "rateLimited" | "publishCap" | "forkCap"; retryAfterSecs: number | null }
  | { kind: "invalid"; field: string | null; rule: string | null };

export type Outcome =
  | {
      kind: "published";
      created: boolean;
      id: string;
      manageKey: string | null;
      previewMatches: boolean | null;
      adjusted: string[];
    }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "gaveUp"; attempts: number; why: "network" | "busy" | "server" }
  | { kind: "cancelled" };

/** Waits before each retry, in milliseconds: three retries, four attempts in all. */
export const BACKOFF_MS = [400, 800, 1600];

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

export function refusalFrom(result: WireResult): Refusal {
  const b = record(result.body);
  const type = typeof b["type"] === "string" ? b["type"].replace("urn:graft:problem:", "") : "";
  const after = typeof b["retry_after_secs"] === "number" ? b["retry_after_secs"] : null;
  switch (type) {
    case "publishing-off":
      return { kind: "publishingOff" };
    case "uploads-off":
      return { kind: "uploadsOff" };
    case "storage-full":
      return { kind: "storageFull" };
    case "rate-limited":
      return { kind: "rateLimited", retryAfterSecs: after };
    case "publish-cap":
      return { kind: "publishCap", retryAfterSecs: after };
    case "fork-cap":
      return { kind: "forkCap", retryAfterSecs: after };
    case "fork-not-permitted":
      return { kind: "forkClosed" };
    case "depth-cap":
      return { kind: "depthCap" };
    case "parent-held":
      return { kind: "parentHeld" };
    case "parent-unavailable":
    case "not-found":
      return { kind: "parentGone" };
    case "key-conflict":
      return { kind: "conflict" };
    case "invalid-field":
      return {
        kind: "invalid",
        field: typeof b["field"] === "string" ? b["field"] : null,
        rule: typeof b["rule"] === "string" ? b["rule"] : null,
      };
    default:
      return { kind: "internal" };
  }
}

/** Statuses that mean "nothing was written, send the same request again". */
const RETRYABLE = new Set([408, 502, 503, 504]);

function isBusy(result: WireResult): boolean {
  const type = String(record(result.body)["type"] ?? "");
  // 503 is also what a switched-off door answers; only `retry-later` (and a gateway's own) is a wait.
  return RETRYABLE.has(result.status) && !/(publishing-off|uploads-off|storage-full)$/.test(type);
}

export interface Options {
  delays?: readonly number[];
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onAttempt?: (attempt: number, of: number) => void;
  signal?: AbortSignal;
}

export async function publishWithRetries(
  wire: Wire,
  body: PublishBody | PublishSourceBody,
  { delays = BACKOFF_MS, sleep, onAttempt, signal }: Options,
): Promise<Outcome> {
  const total = delays.length + 1;
  let why: "network" | "busy" | "server" = "network";
  for (let attempt = 1; attempt <= total; attempt++) {
    if (attempt > 1) {
      await sleep(delays[attempt - 2] ?? 0, signal);
      if (signal?.aborted) return { kind: "cancelled" };
    }
    onAttempt?.(attempt, total);
    let result: WireResult;
    try {
      result = await wire.post(body);
    } catch {
      why = "network";
      continue;
    }
    if (result.status === 200 || result.status === 201) {
      const b = record(result.body);
      const publication = record(b["publication"]);
      // An answer that says "published" but names nothing (a captive portal, a proxy) is not believed.
      if (typeof publication["id"] !== "string" || publication["id"] === "") {
        return { kind: "refused", refusal: { kind: "internal" } };
      }
      return {
        kind: "published",
        created: result.status === 201,
        id: publication["id"],
        manageKey: typeof b["manage_key"] === "string" ? b["manage_key"] : null,
        previewMatches: typeof b["preview_matches"] === "boolean" ? b["preview_matches"] : null,
        adjusted: Array.isArray(b["adjusted_fields"]) ? b["adjusted_fields"].map(String) : [],
      };
    }
    if (isBusy(result)) {
      why = "busy";
      continue;
    }
    return { kind: "refused", refusal: refusalFrom(result) };
  }
  return { kind: "gaveUp", attempts: total, why };
}
