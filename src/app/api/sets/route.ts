import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";
import { strictNumberKey } from "@/lib/pokemontcg";
import { errorJson } from "@/lib/apiError";

/** GET: set completion — every set the member owns a card of, with how far
 *  along they are. The collector's core loop ("what am I missing from
 *  Surging Sparks?"), answered from data the app already holds. No AI, no
 *  credits; the expanded missing-card list is its own route.
 *
 *  Sets are keyed by NAME within a game, same as the collection page's
 *  facets: the same set exists under multiple catalogue id schemes, and
 *  keying by id would show one binder as two half-complete sets.
 *  Ownership is DISTINCT collector numbers — three finishes of one card
 *  are one slot filled. */

interface SetSummary {
  name: string;
  game: "pokemon" | "mtg";
  /** The mtg- set code when every row agrees (drives the Scryfall detail
   *  fetch); null for Pokémon and for name-merged mtg sets. */
  code: string | null;
  owned: number;
  total: number | null;
  pct: number | null;
}

/** Scryfall set sizes, cached in app_state for a week — asked at most once
 *  per set, and written back onto the set's card rows so future loads are
 *  entirely local. */
const MTG_SET_COUNTS_KEY = "mtg_set_counts";
const SET_COUNT_TTL_MS = 7 * 24 * 3_600_000;

async function mtgSetTotal(
  admin: ReturnType<typeof createAdminClient>,
  code: string
): Promise<number | null> {
  try {
    const { data } = await admin
      .from("app_state")
      .select("value")
      .eq("key", MTG_SET_COUNTS_KEY)
      .maybeSingle();
    const cache = (data?.value ?? {}) as Record<string, { n: number; at: string }>;
    const hit = cache[code];
    if (hit && Date.now() - Date.parse(hit.at) < SET_COUNT_TTL_MS) return hit.n;

    const res = await fetch(`https://api.scryfall.com/sets/${encodeURIComponent(code)}`, {
      headers: { Accept: "application/json", "User-Agent": "TCGdeck/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return hit?.n ?? null;
    const set = (await res.json()) as { printed_size?: number; card_count?: number };
    // printed_size is the number on the cards ("123/280"); card_count
    // includes variants beyond it. Prefer the number collectors count to.
    const n = set.printed_size ?? set.card_count ?? null;
    if (n != null) {
      cache[code] = { n, at: new Date().toISOString() };
      await admin
        .from("app_state")
        .upsert({ key: MTG_SET_COUNTS_KEY, value: cache, updated_at: new Date().toISOString() })
        .then(() => {});
      // Write-back: future summaries read it straight off the rows.
      await admin
        .from("cards")
        .update({ set_printed_total: n })
        .eq("set_id", `mtg-${code}`)
        .is("set_printed_total", null)
        .then(() => {});
    }
    return n;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();

    type Row = {
      card:
        | { id: string; set_id: string; set_name: string; number: string; set_printed_total: number | null }
        | Array<{ id: string; set_id: string; set_name: string; number: string; set_printed_total: number | null }>
        | null;
    };
    const { data: rows, error } = await fetchAllRows<Row>(() =>
      supabase
        .from("collection_items")
        .select("card:cards(id, set_id, set_name, number, set_printed_total)")
        .eq("user_id", user.id)
        .order("created_at")
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: Row[] | null;
          error: { message: string } | null;
        }>;
      }
    );
    if (error) throw error;

    const byKey = new Map<
      string,
      { name: string; game: "pokemon" | "mtg"; codes: Set<string>; numbers: Set<string>; total: number | null }
    >();
    for (const r of rows ?? []) {
      const card = Array.isArray(r.card) ? r.card[0] : r.card;
      if (!card?.set_name) continue;
      // Hand-entered customs have a made-up set; a progress bar over it
      // would be fiction.
      if (card.set_id === "custom" || card.id.startsWith("custom-")) continue;
      const game: "pokemon" | "mtg" = card.id.startsWith("scry-") ? "mtg" : "pokemon";
      const key = `${game}|${card.set_name}`;
      const g = byKey.get(key) ?? {
        name: card.set_name,
        game,
        codes: new Set<string>(),
        numbers: new Set<string>(),
        total: null,
      };
      if (game === "mtg" && card.set_id.startsWith("mtg-")) g.codes.add(card.set_id.slice(4));
      const num = strictNumberKey(card.number);
      if (num) g.numbers.add(num);
      if (card.set_printed_total != null) {
        g.total = Math.max(g.total ?? 0, card.set_printed_total);
      }
      byKey.set(key, g);
    }

    // Fill unknown Magic set sizes from Scryfall (cached; a handful of
    // calls the first time, none after).
    const admin = createAdminClient();
    for (const g of byKey.values()) {
      if (g.game === "mtg" && g.total == null && g.codes.size === 1) {
        g.total = await mtgSetTotal(admin, [...g.codes][0]);
      }
    }

    const sets: SetSummary[] = [...byKey.values()]
      .map((g) => {
        const owned = g.numbers.size;
        // A set can legitimately exceed its printed size (secret rares) —
        // the bar caps at 100 rather than lying past it.
        const pct = g.total ? Math.min(100, Math.round((owned / g.total) * 100)) : null;
        return {
          name: g.name,
          game: g.game,
          code: g.codes.size === 1 ? [...g.codes][0] : null,
          owned,
          total: g.total,
          pct,
        };
      })
      .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.owned - a.owned || a.name.localeCompare(b.name));

    return NextResponse.json({ sets });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't total your sets");
  }
}
