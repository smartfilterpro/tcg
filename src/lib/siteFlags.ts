// Site-wide switches the owner flips from the admin page — starting with
// the launch button: whether search engines are welcome.
//
// The flag lives in app_state so flipping it needs no deploy, and it is
// read on EVERY page render (the meta robots tag) plus /robots.txt — so it
// is cached per process for a minute. A stale minute is nothing against a
// search-engine crawl cycle, and it keeps the flag from adding a database
// round trip to each page.
//
// FAIL CLOSED. Any read error means "hidden": the owner chose invisibility
// as the default, and a database hiccup must not accidentally launch the
// site into Google.

import { createAdminClient } from "@/lib/supabase/admin";

const KEY = "site_flags";
const TTL_MS = 60_000;

let cache: { at: number; indexable: boolean } | null = null;

export async function isSiteIndexable(): Promise<boolean> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.indexable;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("app_state")
      .select("value")
      .eq("key", KEY)
      .maybeSingle();
    if (error) throw error;
    const indexable = (data?.value as { indexable?: boolean } | null)?.indexable === true;
    cache = { at: Date.now(), indexable };
    return indexable;
  } catch {
    return cache?.indexable ?? false;
  }
}

export async function setSiteIndexable(indexable: boolean): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("app_state").upsert({
    key: KEY,
    value: { indexable },
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  cache = { at: Date.now(), indexable };
}
