import type { NextConfig } from "next";
import { missingDeploySettings, securityHeaders } from "./lib/security.ts";

// A deployed build that forgot a build-time setting stops here, with the names, instead of shipping a
// site that loads and quietly cannot play audio or report anything.
const missing = missingDeploySettings(process.env);
if (missing.length > 0) {
  throw new Error(
    `this build is for a deployment and is missing: ${missing.join(", ")} (see ARCHITECTURE.md, "Site configuration")`,
  );
}

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
          upgradeInsecure: process.env["GRAFT_UPGRADE_INSECURE_REQUESTS"] === "on",
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
