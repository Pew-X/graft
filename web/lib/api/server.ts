/**
 * Where the service is, read when a request arrives (not baked into the build), so one build serves
 * every environment. `GRAFT_API_URL` is how this server reaches it; `GRAFT_PUBLIC_API_URL` is how
 * a browser reaches it, when that differs (it defaults to the same).
 */
export function apiUrls(env: Record<string, string | undefined> = process.env): {
  server: string;
  browser: string;
} {
  const server = (env["GRAFT_API_URL"] ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  const browser = (env["GRAFT_PUBLIC_API_URL"] ?? server).replace(/\/+$/, "");
  return { server, browser };
}
