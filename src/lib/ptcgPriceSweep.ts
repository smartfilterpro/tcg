// The free daily price sweep for the Pokémon catalogue.
//
// Magic has had this from day one: the hourly Scryfall loop refreshes every
// MTG row, owned or not, because its source is free. Pokémon's paid tracker
// walks the catalogue too, but on a metered budget, slowly, and files one
// number under "normal" — so unowned rows and per-finish (reverse holo)
// prices lagged, which is exactly what the set-completion page surfaced as
// "+170 unpriced".
//
// This sweep is the parity fix: once a day, find the sets carrying price
// gaps, ask pokemontcg.io for each set's full TCGplayer price maps (free,
// two requests per set), and MERGE-FILL — a value a row already holds is
// never overwritten, so the owned-card corroboration machinery and the
// held-price review queue keep their authority. This fills blanks; it
// doesn't referee disputes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";
import { mergePrices } from "@/lib/cardWrite";
import { strictNumberKey } from "@/lib/pokemontcg";

const PAGE_SIZE = 250;
const MAX_SETS_PER_RUN = 40;
const PACE_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSetPriceMaps(
  setId: string
): Promise<Map<string, Record<string, number | null>>> {
  const byId = new Map<string, Record<string, number | null>>();
  for (let page = 1; page <= 2; page++) {
    const headers: Record<string, string> = {};
    const apiKey = (process.env.POKEMONTCG_API_KEY ?? "").trim();
    if (apiKey) headers["X-Api-Key"] = apiKey;
    const res = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`set.id:${setId}`)}&page=${page}&pageSize=${PAGE_SIZE}&select=id,number,tcgplayer`,
      { headers, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) break;
    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        number: string;
        tcgplayer?: { prices?: Record<string, { market?: number | null; mid?: number | null }> };
      }>;
    };
    for (const c of json.data ?? []) {
      const map: Record<string, number | null> = {};
      for (const [f, v] of Object.entries(c.tcgplayer?.prices ?? {})) {
        const n = v?.market ?? v?.mid ?? null;
        if (n != null && n > 0) map[f] = n;
      }
      if (Object.keys(map).length > 0) byId.set(c.id, map);
    }
    if ((json.data?.length ?? 0) < PAGE_SIZE) break;
    await sleep(PACE_MS);
  }
  return byId;
}

export async function sweepPokemonSetPrices(admin: SupabaseClient): Promise<string> {
  // Which sets carry gaps. A row with no headline price is the loud kind;
  // rows whose maps lack finishes are found once we're in the set anyway.
  type GapRow = { id: string; set_id: string | null };
  const { data: gapRows, error } = await fetchAllRows<GapRow>(() =>
    admin
      .from("cards")
      .select("id, set_id")
      .is("market_price", null)
      .order("set_id")
      .order("id") as unknown as {
      range: (from: number, to: number) => PromiseLike<{
        data: GapRow[] | null;
        error: { message: string } | null;
      }>;
    }
  );
  if (error) throw error;

  const setCounts = new Map<string, number>();
  for (const r of gapRows ?? []) {
    // Plain-scheme ids only: those are pokemontcg.io's own, so their set_id
    // is a set the API can be asked about. Other schemes ride along when
    // their number matches at write time... they don't — merge is by id.
    if (!r.set_id || /^(tcgdex-|tcgp-|scry-|custom-)/.test(r.id)) continue;
    setCounts.set(r.set_id, (setCounts.get(r.set_id) ?? 0) + 1);
  }
  const targets = [...setCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SETS_PER_RUN)
    .map(([id]) => id);
  if (targets.length === 0) return "ptcg price sweep: no gaps";

  let updated = 0;
  let setsDone = 0;
  for (const setId of targets) {
    let maps: Map<string, Record<string, number | null>>;
    try {
      maps = await fetchSetPriceMaps(setId);
    } catch {
      continue; // upstream hiccup — tomorrow's run gets another go
    }
    if (maps.size === 0) continue;
    setsDone++;

    // Every plain row in the set — priced ones included, so a tracker-priced
    // row can still LEARN its reverse-holo number (merge adds missing keys,
    // never replaces existing ones).
    type SetRow = {
      id: string;
      market_price: number | null;
      prices: Record<string, number | null> | null;
    };
    const { data: rows } = await fetchAllRows<SetRow>(() =>
      admin
        .from("cards")
        .select("id, market_price, prices")
        .eq("set_id", setId)
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: SetRow[] | null;
          error: { message: string } | null;
        }>;
      }
    );
    for (const row of rows ?? []) {
      const map = maps.get(row.id);
      if (!map) continue;
      const merged = mergePrices(row.prices, map);
      const headline =
        row.market_price ??
        map.normal ?? map.holofoil ?? map.reverseHolofoil ?? Object.values(map)[0] ?? null;
      const changed =
        JSON.stringify(merged ?? {}) !== JSON.stringify(row.prices ?? {}) ||
        (row.market_price == null && headline != null);
      if (!changed) continue;
      const { error: writeErr } = await admin
        .from("cards")
        .update({
          market_price: headline,
          prices: merged,
          ...(row.market_price == null ? { price_updated_at: new Date().toISOString() } : {}),
        })
        .eq("id", row.id);
      if (!writeErr) updated++;
    }
    await sleep(PACE_MS);
  }
  return `ptcg price sweep: ${setsDone}/${targets.length} sets, ${updated} rows filled`;
}

const STATE_KEY = "ptcg_price_sweep_at";
const DAY_MS = 24 * 3_600_000;

/** Daily, riding the same long-lived process as every other loop. The claim
 *  is written before the work so a failing day retries tomorrow instead of
 *  hammering the free API hourly. */
export function startPtcgPriceSweepLoop(): void {
  const tick = async () => {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      const { data } = await admin
        .from("app_state")
        .select("value")
        .eq("key", STATE_KEY)
        .maybeSingle();
      const last = Date.parse((data?.value as { at?: string } | null)?.at ?? "");
      if (Number.isFinite(last) && Date.now() - last < DAY_MS) return;
      await admin.from("app_state").upsert({
        key: STATE_KEY,
        value: { at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });
      console.log(await sweepPokemonSetPrices(admin));
    } catch (err) {
      console.warn("ptcg price sweep: skipped", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(tick, 150_000); // after boot settles, behind the other loops
  setInterval(tick, 3_600_000);
}
