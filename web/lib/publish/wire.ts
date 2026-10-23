import type { PublishBody, PublishSourceBody, Wire, WireResult } from "./client.ts";

/** The real network: one POST to the service. A failure to get any answer throws, which the caller retries. */
export function wireFor(apiUrl: string, path = "/v1/publications"): Wire {
  return {
    async post(body: PublishBody | PublishSourceBody): Promise<WireResult> {
      const response = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* an answer that is not JSON is read as an unexplained failure by the caller */
      }
      return { status: response.status, body: parsed };
    },
  };
}
