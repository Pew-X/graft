import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
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
