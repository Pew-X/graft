/** What the service says about one publication, read with no key: the same public read the manage page and "your flips" make. */
export interface Shown {
  state: string;
  title: string;
  author: string;
  forkPermitted: boolean | null;
}

/** `null` when there is no such publication; throws when the service did not answer properly. */
export async function readPublication(
  apiUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<Shown | null> {
  const response = await fetch(`${apiUrl}/v1/publications/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(String(response.status));
  const entry = (await response.json()) as Record<string, unknown>;
  return {
    state: String(entry["state"]),
    title: String(entry["title"] ?? ""),
    author: String(entry["author"] ?? ""),
    forkPermitted: typeof entry["fork_permitted"] === "boolean" ? entry["fork_permitted"] : null,
  };
}
