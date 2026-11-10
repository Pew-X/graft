import type { MetadataRoute } from "next";

// What a crawler may read: the pages a visitor is meant to share. The operator page, the maker's manage
// pages, the list of this browser's own flips and the site's server routes are not for a search index.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/manage/", "/flips", "/api/"] },
  };
}
