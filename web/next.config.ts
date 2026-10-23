import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security.ts";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Every page: the policy, secure transport, no sniffing, no referrer, a narrow device policy.
        source: "/:path*",
        headers: securityHeaders({
          production: process.env["NODE_ENV"] === "production",
          connectOrigins: process.env["GRAFT_CONNECT_ORIGINS"],
        }),
      },
      {
        // The seeded chain's audio is named by the SHA-256 of its bytes, so a given address can
        // never serve different content: it may be cached for a year and never revalidated.
        source: "/seed/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // The operator's page is not for search engines or archives, whatever links to it.
        source: "/admin",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
    ];
  },
};

export default config;
