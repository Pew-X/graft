/** A report about a publication. No account and no contact details: only what is below is sent. */
export interface Reply {
  status: number;
  text(): Promise<string>;
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<Reply>;

export const CATEGORIES = ["rights", "private_conversation", "harmful", "spam", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const NOTE_MAX = 500;

export type Result =
  | { kind: "sent" }
  | { kind: "rateLimited"; retryAfterSecs: number | null }
  | { kind: "gone" }
  | { kind: "invalid"; rule: string | null }
  | { kind: "unreachable" };

export async function sendReport(
  fetcher: Fetcher,
  apiUrl: string,
  report: { id: string; category: Category; note: string },
): Promise<Result> {
  const note = report.note.trim();
  try {
    const reply = await fetcher(`${apiUrl}/v1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        publication_id: report.id,
        category: report.category,
        ...(note === "" ? {} : { note }),
      }),
    });
    if (reply.status === 201) return { kind: "sent" };
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await reply.text()) as Record<string, unknown>;
    } catch {
      /* an answer that is not JSON is an unexplained failure */
    }
    const type = String(body["type"] ?? "").replace("urn:graft:problem:", "");
    if (type === "rate-limited") {
      const after = body["retry_after_secs"];
      return { kind: "rateLimited", retryAfterSecs: typeof after === "number" ? after : null };
    }
    if (type === "not-found") return { kind: "gone" };
    if (type === "invalid-field")
      return { kind: "invalid", rule: typeof body["rule"] === "string" ? body["rule"] : null };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}
