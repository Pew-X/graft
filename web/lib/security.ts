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

export function contentSecurityPolicy({ production, connectOrigins }: PolicyOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    ["connect-src 'self'", ...origins(connectOrigins)].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (production) directives.push("upgrade-insecure-requests");
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
