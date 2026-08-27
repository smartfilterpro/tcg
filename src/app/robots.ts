import type { MetadataRoute } from "next";

// PRE-LAUNCH: the site is hidden from search engines on purpose — the
// owner wants the rebrand and the two-game launch settled before anything
// gets indexed. Served at /robots.txt.
//
// TO LAUNCH: change this to `allow: "/"` (and drop the noindex from the
// root layout's metadata.robots — BOTH must flip together, or the site
// stays invisible with a welcoming robots.txt).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
