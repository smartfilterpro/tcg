import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";
import { strictNumberKey } from "@/lib/pokemontcg";
import { availableVariants } from "@/lib/types";
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

export async function GET(req: Request) {
  try {
    const { user } = await requireUser();
    const mode = new URL(req.url).searchParams.get("mode") === "master" ? "master" : "base";
    const supabase = await createClient();

    type CardBits = {
      id: string;
      set_id: string;
      set_name: string;
      number: string;
      set_printed_total: number | null;
      prices: Record<string, number | null> | null;
      rarity: string | null;
      name: string;
    };
    type Row = { variant: string | null; card: CardBits | CardBits[] | null };
    const { data: rows, error } = await fetchAllRows<Row>(() =>
      supabase
        .from("collection_items")
        .select(
          "variant, card:cards(id, set_id, set_name, number, set_printed_total, prices, rarity, name)"
        )
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

    /** Finishes a card is known to come in — the same inference the rest of
     *  the app uses (price keys plus rarity rules), which is what makes a
     *  MASTER-set slot: one per printed finish. Stamps and ball patterns are
     *  deliberately not slots — they're bonus variants, not set members. */
    const finishesOf = (c: CardBits, game: "pokemon" | "mtg"): string[] =>
      availableVariants({ prices: c.prices, rarity: c.rarity, name: c.name, game });

    interface SetAgg {
      name: string;
      game: "pokemon" | "mtg";
      codes: Set<string>;
      /** Owned distinct collector numbers. */
      ownedNumbers: Set<string>;
      /** Owned (number|finish) pairs, master mode's numerator — only pairs
       *  the finish universe recognises count, so a stamp neither adds nor
       *  fills a slot. */
      ownedSlots: Set<string>;
      /** number → union of known finishes, across every printing seen. */
      expected: Map<string, Set<string>>;
      printed: number | null;
    }
    const byKey = new Map<string, SetAgg>();
    const aggFor = (key: string, name: string, game: "pokemon" | "mtg"): SetAgg => {
      const g = byKey.get(key) ?? {
        name,
        game,
        codes: new Set<string>(),
        ownedNumbers: new Set<string>(),
        ownedSlots: new Set<string>(),
        expected: new Map<string, Set<string>>(),
        printed: null,
      };
      byKey.set(key, g);
      return g;
    };
    const learn = (g: SetAgg, num: string, c: CardBits, game: "pokemon" | "mtg") => {
      const set = g.expected.get(num) ?? new Set<string>();
      for (const f of finishesOf(c, game)) set.add(f);
      g.expected.set(num, set);
    };

    for (const r of rows ?? []) {
      const card = Array.isArray(r.card) ? r.card[0] : r.card;
      if (!card?.set_name) continue;
      // Hand-entered customs have a made-up set; a progress bar over it
      // would be fiction.
      if (card.set_id === "custom" || card.id.startsWith("custom-")) continue;
      const game: "pokemon" | "mtg" = card.id.startsWith("scry-") ? "mtg" : "pokemon";
      const g = aggFor(`${game}|${card.set_name}`, card.set_name, game);
      if (game === "mtg" && card.set_id.startsWith("mtg-")) g.codes.add(card.set_id.slice(4));
      const num = strictNumberKey(card.number);
      if (!num) continue;
      g.ownedNumbers.add(num);
      learn(g, num, card, game);
      const v = r.variant ?? "normal";
      if (g.expected.get(num)?.has(v)) g.ownedSlots.add(`${num}|${v}`);
      if (card.set_printed_total != null) {
        g.printed = Math.max(g.printed ?? 0, card.set_printed_total);
      }
    }

    // Fill unknown Magic set sizes from Scryfall (cached; a handful of
    // calls the first time, none after).
    const admin = createAdminClient();
    for (const g of byKey.values()) {
      if (g.game === "mtg" && g.printed == null && g.codes.size === 1) {
        g.printed = await mtgSetTotal(admin, [...g.codes][0]);
      }
    }

    // THE DENOMINATOR IS EVERY CARD KNOWN TO EXIST, not the printed size.
    //
    // Secret rares are numbered PAST the printed total ("94/88") and count
    // toward owned — so owned/printedTotal once read "116 of 88 · 100%
    // complete!" over eight missing cards. The universe is printed size ∪
    // the catalogue's distinct numbers ∪ the owned numbers — the same one
    // the expanded missing-list uses, so the two can never disagree. In
    // master mode each known card contributes a slot PER FINISH.
    try {
      const names = [...new Set([...byKey.values()].map((g) => g.name))];
      for (let i = 0; i < names.length; i += 25) {
        type CatRow = {
          id: string;
          set_id: string;
          set_name: string;
          number: string;
          prices: Record<string, number | null> | null;
          rarity: string | null;
          name: string;
        };
        const { data: catRows } = await fetchAllRows<CatRow>(() =>
          admin
            .from("cards")
            .select("id, set_id, set_name, number, prices, rarity, name")
            .in("set_name", names.slice(i, i + 25))
            .order("id") as unknown as {
            range: (from: number, to: number) => PromiseLike<{
              data: CatRow[] | null;
              error: { message: string } | null;
            }>;
          }
        );
        for (const c of catRows ?? []) {
          if (c.id.startsWith("custom-")) continue;
          const game: "pokemon" | "mtg" = c.id.startsWith("scry-") ? "mtg" : "pokemon";
          const g = byKey.get(`${game}|${c.set_name}`);
          if (!g) continue;
          const num = strictNumberKey(c.number);
          if (!num) continue;
          learn(g, num, c as CardBits, game);
        }
      }
      // A catalogue printing can widen a number's finish set AFTER the owned
      // pass judged a variant unrecognised — re-check owned pairs against
      // the final universe.
      for (const r of rows ?? []) {
        const card = Array.isArray(r.card) ? r.card[0] : r.card;
        if (!card?.set_name || card.set_id === "custom" || card.id.startsWith("custom-")) continue;
        const game: "pokemon" | "mtg" = card.id.startsWith("scry-") ? "mtg" : "pokemon";
        const g = byKey.get(`${game}|${card.set_name}`);
        const num = strictNumberKey(card.number);
        if (!g || !num) continue;
        const v = r.variant ?? "normal";
        if (g.expected.get(num)?.has(v)) g.ownedSlots.add(`${num}|${v}`);
      }
    } catch {
      // Catalogue unreadable: printed sizes still carry the page.
    }

    const sets: SetSummary[] = [...byKey.values()]
      .map((g) => {
        const knownNumbers = Math.max(g.expected.size, g.ownedNumbers.size);
        // Cards the printed size promises but nobody has catalogued yet:
        // one slot each (their finishes are unknown, one is the minimum).
        const uncatalogued = Math.max(0, (g.printed ?? 0) - knownNumbers);
        let owned: number;
        let total: number | null;
        if (mode === "master") {
          let slots = 0;
          for (const fins of g.expected.values()) slots += Math.max(1, fins.size);
          owned = g.ownedSlots.size;
          total = slots + uncatalogued || null;
        } else {
          owned = g.ownedNumbers.size;
          const known = knownNumbers + uncatalogued;
          total = known > 0 ? known : null;
        }
        if (total != null && owned > total) total = owned;
        const pct = total ? Math.min(100, Math.round((owned / total) * 100)) : null;
        return {
          name: g.name,
          game: g.game,
          code: g.codes.size === 1 ? [...g.codes][0] : null,
          owned,
          total,
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
