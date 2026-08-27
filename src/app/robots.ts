import type { MetadataRoute } from "next";
import { isSiteIndexable } from "@/lib/siteFlags";

// Served at /robots.txt. Driven by the admin page's "visible to search
// engines" switch — the same flag also controls the meta noindex in the
// root layout, so one flip changes both signals together. Until the owner
// flips it, every crawler is turned away.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const indexable = await isSiteIndexable();
  return {
    rules: indexable ? { userAgent: "*", allow: "/" } : { userAgent: "*", disallow: "/" },
  };
}
