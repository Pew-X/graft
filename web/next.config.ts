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
    ];
  },
};

export default config;
