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
