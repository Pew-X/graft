/**
 * The security headers the site sends on every page. The addresses the page may connect to (the
 * service, and the bucket audio is read from) come from the environment, because where the site is
 * deployed is not known here; an address that is not a plain origin stops the build, so a typo
 * cannot quietly widen the policy.
 *
 * What the policy does not do, and why: it allows inline scripts, because the framework's own
 * start-up script is inline and a per-request nonce would make every page dynamic, including the
 * home page that is served as a static file. The protection against script injection is therefore
 * that nothing the site prints is ever treated as markup (everything is escaped, and the service
 * refuses angle brackets in all public text), not this header; the header still stops framing,
 * plugins, a changed base address, forms sent elsewhere and connections to other origins.
 */

export interface Header {
  key: string;
  value: string;
}

export interface PolicyOptions {
  production: boolean;
  /** Comma-separated origins the page may connect to besides itself. */
  connectOrigins?: string | undefined;
  /**
   * Make the browser fetch every request of the page over https. Off by default, because it breaks a
   * page served over plain http (a LAN test, a preview): browsers exempt only localhost. A production
   * site behind https sets it (`GRAFT_UPGRADE_INSECURE_REQUESTS=on` when the site is built).
   */
  upgradeInsecure?: boolean | undefined;
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

function origins(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "")
    .map((o) => {
      if (!ORIGIN.test(o)) throw new Error(`"${o}" is not an origin (scheme, host, optional port)`);
      return o;
    });
}

export function contentSecurityPolicy({
  production,
  connectOrigins,
  upgradeInsecure,
}: PolicyOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    ["connect-src 'self'", ...origins(connectOrigins)].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (upgradeInsecure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaders(options: PolicyOptions): Header[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    // The microphone is for the maker's own recording; nothing else on the device is asked for.
    { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  ];
}

type Env = Record<string, string | undefined>;

/**
 * Whether this build is for a deployment: Vercel says so (`VERCEL_ENV` is `production` or `preview`),
 * and any other host can say so with `GRAFT_DEPLOY_BUILD=on`. A local build and the test builds are not.
 */
export function isDeployBuild(env: Env): boolean {
  return (
    env["GRAFT_DEPLOY_BUILD"] === "on" ||
    env["VERCEL_ENV"] === "production" ||
    env["VERCEL_ENV"] === "preview"
  );
}

/**
 * The settings a deployed build must carry, because they are read when the site is built and leaving
 * one out breaks the site without an error: no origin to connect to means chain pages cannot load
 * audio and events go nowhere; no public service address means the home page reports nothing; and
 * whether to upgrade requests to https is a decision to be made, not a default to be missed.
 * Returns the names of the missing ones; empty for a build that is not for a deployment.
 */
export function missingDeploySettings(env: Env): string[] {
  if (!isDeployBuild(env)) return [];
  const missing: string[] = [];
  if ((env["GRAFT_CONNECT_ORIGINS"] ?? "").trim() === "") missing.push("GRAFT_CONNECT_ORIGINS");
  if ((env["GRAFT_PUBLIC_API_URL"] ?? "").trim() === "") missing.push("GRAFT_PUBLIC_API_URL");
  const upgrade = env["GRAFT_UPGRADE_INSECURE_REQUESTS"];
  if (upgrade !== "on" && upgrade !== "off") missing.push("GRAFT_UPGRADE_INSECURE_REQUESTS");
  return missing;
}
