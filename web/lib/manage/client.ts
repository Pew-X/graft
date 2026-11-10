/**
 * What a maker can do to their own publication: close it to new flips or reopen it, and withdraw it.
 * The manage key travels in one header, never in an address or a body, and is never kept or logged
 * here. Every way of being refused is the one answer, because the service gives no more.
 */
export interface Reply {
  status: number;
  text(): Promise<string>;
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<Reply>;

export type Result =
  | { kind: "done"; forkPermitted: boolean; withdrawn: boolean }
  | { kind: "refused" }
  | { kind: "busy" }
  | { kind: "unreachable" };

const HEADER = "x-graft-manage-key";

async function send(
  fetcher: Fetcher,
  url: string,
  method: "PUT" | "POST",
  key: string,
  body?: unknown,
): Promise<Result> {
  // A header value cannot hold a line break; a key that could not have been issued is just refused.
  if (key === "" || /[\r\n\0]/.test(key)) return { kind: "refused" };
  try {
    const headers: Record<string, string> = { [HEADER]: key };
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const reply = await fetcher(url, init);
    if (reply.status === 200) {
      const parsed = JSON.parse(await reply.text()) as {
        fork_permitted?: unknown;
        withdrawn?: unknown;
      };
      return {
        kind: "done",
        forkPermitted: parsed.fork_permitted === true,
        withdrawn: parsed.withdrawn === true,
      };
    }
    if (reply.status === 403 || reply.status === 404) return { kind: "refused" };
    if (reply.status === 503) return { kind: "busy" };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

export function setForkPermission(
  fetcher: Fetcher,
  apiUrl: string,
  id: string,
  key: string,
  permitted: boolean,
): Promise<Result> {
  return send(
    fetcher,
    `${apiUrl}/v1/publications/${encodeURIComponent(id)}/fork-permission`,
    "PUT",
    key,
    { permitted },
  );
}

export function withdraw(
  fetcher: Fetcher,
  apiUrl: string,
  id: string,
  key: string,
): Promise<Result> {
  return send(fetcher, `${apiUrl}/v1/publications/${encodeURIComponent(id)}/withdraw`, "POST", key);
}

export type NoteResult =
  | { kind: "saved"; note: string | null; adjusted: boolean }
  | { kind: "refused" | "locked" | "limited" | "closed" | "busy" | "unreachable" }
  | { kind: "invalid"; rule: string | null };

/**
 * Write, change or clear (with an empty note) the note on a publication. Every way of being refused the
 * key is the one answer `refused`; a withdrawn publication says `locked`; a note that breaks the title
 * rules says which (`invalid`); and switched-off publishing says `closed`, so the page can be honest about why.
 */
export async function setNote(
  fetcher: Fetcher,
  apiUrl: string,
  id: string,
  key: string,
  note: string,
): Promise<NoteResult> {
  if (key === "" || /[\r\n\0]/.test(key)) return { kind: "refused" };
  try {
    const reply = await fetcher(`${apiUrl}/v1/publications/${encodeURIComponent(id)}/note`, {
      method: "PUT",
      headers: { [HEADER]: key, "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const text = await reply.text();
    const body = ((): Record<string, unknown> => {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })();
    if (reply.status === 200) {
      return {
        kind: "saved",
        note: typeof body["note"] === "string" && body["note"] !== "" ? body["note"] : null,
        adjusted: body["adjusted"] === true,
      };
    }
    const type =
      typeof body["type"] === "string" ? body["type"].replace("urn:graft:problem:", "") : "";
    if (reply.status === 403 || reply.status === 404) return { kind: "refused" };
    if (reply.status === 409) return { kind: "locked" };
    if (reply.status === 422)
      return { kind: "invalid", rule: typeof body["rule"] === "string" ? body["rule"] : null };
    if (reply.status === 429) return { kind: "limited" };
    if (reply.status === 503)
      return type === "publishing-off" ? { kind: "closed" } : { kind: "busy" };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}
