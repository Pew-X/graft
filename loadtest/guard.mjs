// Where the load test may point. The test writes at its own pace, so it must never reach production:
// the default is no, and a host is allowed only when it is the machine's own address, has a `staging`
// label in its name (a whole label or a whole dash-separated word: not a path, not a user name, not a
// lookalike), or is named by the operator. A host named as production is refused whatever else is true.
// No imports and no Node-only calls, so k6 can load it and the tests can too.

/** @param {string | undefined} list comma-separated host names */
const names = (list) =>
  (list ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== "");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "host.docker.internal"]);

/**
 * @param {string} baseUrl
 * @param {{ allowedHosts?: string, productionHosts?: string }} [env]
 * @returns {{ ok: true, host: string } | { ok: false, reason: string }}
 */
export function checkTarget(baseUrl, env = {}) {
  const match = /^(https?):\/\/([^/?#]*)([/?#].*)?$/i.exec(String(baseUrl ?? ""));
  if (!match) return { ok: false, reason: `${baseUrl || "(empty)"} is not an http or https address` };
  const authority = match[2] ?? "";
  if (authority.includes("@")) return { ok: false, reason: "an address with a user name is not accepted" };
  // The host without its port (an IPv6 literal keeps its brackets).
  const host = authority.replace(/:\d+$/, "").toLowerCase();
  if (names(env.productionHosts).includes(host)) {
    return { ok: false, reason: `${host} is named as production: the load test never runs there` };
  }
  if (LOCAL.has(host) || names(env.allowedHosts).includes(host)) return { ok: true, host };
  const stagingLabel = host.split(".").some((label) => label.split("-").includes("staging"));
  if (stagingLabel) return { ok: true, host };
  return { ok: false, reason: `${host} is not known to be a test environment (staging label, local address, or named by the operator)` };
}
