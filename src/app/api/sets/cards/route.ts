import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";
import { strictNumberKey } from "@/lib/pokemontcg";
import { buyLinkFor } from "@/lib/buyLink";
import { masterSetFinishes, variantLabel } from "@/lib/types";
import { errorJson } from "@/lib/apiError";

/** GET ?game=&set=&code= — one set, card by card: what's owned, what's
 *  missing, what the gap costs, where to buy each piece.
 *
 *  The card list comes from our own catalogue first. For Magic the
 *  catalogue is built lazily, so a set we hold thinly is completed from
 *  Scryfall (free, keyless) — the response says when even that couldn't
 *  produce the whole set. For Pokémon the catalogue import is the source
 *  of truth; a thin set is reported as exactly that rather than padded
 *  with guesses. */

interface SetCardEntry {
  number: string;
  name: string;
  price: number | null;
  image: string | null;
  owned: boolean;
  /** Master mode only: which finish this slot is ("normal", "reverseHolofoil"…). */
  finish?: string;
  finishLabel?: string;
  buyUrl?: string;
}

export async function GET(req: Request) {
  try {
    const { user } = await requireUser();
    const url = new URL(req.url);
    const setName = url.searchParams.get("set")?.trim();
    const game = url.searchParams.get("game") === "mtg" ? "mtg" : "pokemon";
    const code = url.searchParams.get("code")?.trim().toLowerCase() || null;
    const master = url.searchParams.get("mode") === "master";
    if (!setName) return NextResponse.json({ error: "Which set?" }, { status: 400 });

    const supabase = await createClient();

    // The catalogue's copy of the set. One row per collector number — the
    // representative printing is whichever has an image and a price.
    type CatRow = {
      id: string;
      name: string;
      number: string;
      image_small: string | null;
      market_price: number | null;
      tcgplayer_id: string | null;
      prices: Record<string, number | null> | null;
      rarity: string | null;
    };
    const { data: catRows, error: catErr } = await fetchAllRows<CatRow>(() =>
      supabase
        .from("cards")
        .select("id, name, number, image_small, market_price, tcgplayer_id, prices, rarity")
        .eq("set_name", setName)
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: CatRow[] | null;
          error: { message: string } | null;
        }>;
      }
    );
    if (catErr) throw catErr;

    const byNumber = new Map<string, SetCardEntry & { hasTcgp: boolean }>();
    /** Master mode's finish universe and per-finish prices, keyed by number.
     *  The union across printings, same as the summary route. */
    const finishesByNumber = new Map<string, Set<string>>();
    const finishPrice = new Map<string, number>(); // `${num}|${finish}` → USD
    const consider = (c: {
      id?: string;
      name: string;
      number: string;
      image: string | null;
      price: number | null;
      tcgplayerId: string | null;
      prices?: Record<string, number | null> | null;
      rarity?: string | null;
    }) => {
      const key = strictNumberKey(c.number);
      if (!key) return;
      if (master) {
        const fins = finishesByNumber.get(key) ?? new Set<string>();
        for (const f of masterSetFinishes({
          prices: c.prices ?? null,
          rarity: c.rarity ?? null,
          name: c.name,
          game,
        }))
          fins.add(f);
        finishesByNumber.set(key, fins);
        for (const [f, pr] of Object.entries(c.prices ?? {})) {
          if (pr != null && pr > 0) {
            const fk = `${key}|${f}`;
            if (!finishPrice.has(fk) || pr < finishPrice.get(fk)!) finishPrice.set(fk, pr);
          }
        }
      }
      const prev = byNumber.get(key);
      const better =
        !prev ||
        (prev.image == null && c.image != null) ||
        (prev.price == null && c.price != null);
      if (better) {
        byNumber.set(key, {
          number: c.number.split("/")[0].trim(),
          name: c.name,
          price: c.price,
          image: c.image,
          owned: false,
          hasTcgp: c.tcgplayerId != null,
          ...(c.tcgplayerId != null
            ? { buyUrl: buyLinkFor({ tcgplayerId: c.tcgplayerId, name: c.name }) }
            : {}),
        });
      }
    };
    for (const r of catRows ?? []) {
      if ((r.id.startsWith("scry-") ? "mtg" : "pokemon") !== game) continue;
      consider({
        id: r.id,
        name: r.name,
        number: r.number,
        image: r.image_small,
        price: r.market_price,
        tcgplayerId: r.tcgplayer_id,
        prices: r.prices,
        rarity: r.rarity,
      });
    }

    // Magic: complete a thin set from Scryfall — the catalogue only holds
    // what someone has scanned, and a completion list needs the whole set.
    let external = false;
    if (game === "mtg" && code) {
      try {
        let page = `https://api.scryfall.com/cards/search?order=set&unique=prints&q=${encodeURIComponent(
          `set:${code}`
        )}`;
        for (let i = 0; i < 3 && page; i++) {
          const res = await fetch(page, {
            headers: { Accept: "application/json", "User-Agent": "TCGdeck/1.0" },
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) break;
          const json = (await res.json()) as {
            data?: Array<{
              name: string;
              collector_number: string;
              digital?: boolean;
              image_uris?: { small?: string };
              card_faces?: Array<{ image_uris?: { small?: string } }>;
              prices?: { usd?: string | null; usd_foil?: string | null };
              tcgplayer_id?: number;
            }>;
            has_more?: boolean;
            next_page?: string;
          };
          for (const c of json.data ?? []) {
            if (c.digital) continue;
            const usd = parseFloat(c.prices?.usd ?? c.prices?.usd_foil ?? "");
            const key = strictNumberKey(c.collector_number);
            // Scryfall only fills numbers the catalogue doesn't hold — a
            // held row already carries our prices and buy id.
            if (key && !byNumber.has(key)) {
              const foil = parseFloat(c.prices?.usd_foil ?? "");
              const priceMap: Record<string, number | null> = {};
              if (c.prices?.usd != null) priceMap.normal = parseFloat(c.prices.usd);
              if (Number.isFinite(foil)) priceMap.foil = foil;
              consider({
                name: c.name,
                number: c.collector_number,
                image: c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small ?? null,
                price: Number.isFinite(usd) ? usd : null,
                tcgplayerId: c.tcgplayer_id != null ? String(c.tcgplayer_id) : null,
                prices: Object.keys(priceMap).length > 0 ? priceMap : null,
              });
            }
          }
          external = true;
          page = json.has_more && json.next_page ? json.next_page : "";
        }
      } catch {
        // The local slice still answers; the note below says it's partial.
      }
    }

    // What the member owns in this set, by number.
    type OwnRow = {
      variant: string | null;
      card: { id: string; set_name: string; number: string } | Array<{ id: string; set_name: string; number: string }> | null;
    };
    const { data: ownRows } = await fetchAllRows<OwnRow>(() =>
      supabase
        .from("collection_items")
        .select("variant, card:cards(id, set_name, number)")
        .eq("user_id", user.id)
        .order("created_at")
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: OwnRow[] | null;
          error: { message: string } | null;
        }>;
      }
    );
    const ownedVariants = new Map<string, Set<string>>(); // number → owned finishes
    for (const r of ownRows ?? []) {
      const card = Array.isArray(r.card) ? r.card[0] : r.card;
      if (!card || card.set_name !== setName) continue;
      if ((card.id.startsWith("scry-") ? "mtg" : "pokemon") !== game) continue;
      const key = strictNumberKey(card.number);
      if (key) {
        const vs = ownedVariants.get(key) ?? new Set<string>();
        vs.add(r.variant ?? "normal");
        ownedVariants.set(key, vs);
      }
      const entry = key ? byNumber.get(key) : undefined;
      if (entry) entry.owned = true;
      else if (key) {
        // Owned but not in the catalogue slice (odd numbering) — it still
        // counts as a filled slot rather than vanishing.
        byNumber.set(key, {
          number: card.number.split("/")[0].trim(),
          name: "",
          price: null,
          image: null,
          owned: true,
          hasTcgp: false,
        });
      }
    }

    const numeric = (n: string) => {
      const d = n.replace(/\D/g, "");
      return d ? parseInt(d, 10) : Number.MAX_SAFE_INTEGER;
    };
    const FINISH_ORDER = ["any", "normal", "holofoil", "reverseHolofoil", "foil", "etched"];
    const cards = [...byNumber.entries()]
      .flatMap(([key, entry]) => {
        const { hasTcgp: _h, ...c } = entry;
        if (!master) return [c];
        // One row per slot. "Specifics beat any" (same rule as the summary):
        // a number whose rarity names real finishes drops the unknown slot.
        const finSet = finishesByNumber.get(key) ?? new Set(["any"]);
        if (finSet.size > 1 && finSet.has("any")) finSet.delete("any");
        const fins = [...finSet].sort(
          (a, b) => FINISH_ORDER.indexOf(a) - FINISH_ORDER.indexOf(b)
        );
        const ownedFins = ownedVariants.get(key) ?? new Set<string>();
        return fins.map((f) => ({
          ...c,
          finish: f,
          // An "any" slot is the card itself — no finish chip, headline
          // price, and every recorded finish fills it.
          ...(f === "any" ? {} : { finishLabel: variantLabel(f) }),
          owned: f === "any" ? ownedFins.size > 0 : ownedFins.has(f),
          price:
            f === "any"
              ? c.price
              : finishPrice.get(`${key}|${f}`) ?? (f === "normal" ? c.price : null),
        }));
      })
      .sort((a, b) => numeric(a.number) - numeric(b.number) || a.number.localeCompare(b.number));

    const missing = cards.filter((c) => !c.owned);
    let missingCost = 0;
    let unpriced = 0;
    for (const m of missing) {
      if (m.price != null) missingCost += m.price;
      else unpriced++;
    }

    return NextResponse.json({
      cards,
      missingCost: Math.round(missingCost * 100) / 100,
      unpriced,
      // Honesty flag: the list is only as complete as its sources. Magic
      // sets completed from Scryfall are whole; a thin Pokémon set means
      // the catalogue import hasn't reached it.
      catalogued: cards.length,
      external,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't list that set");
  }
}
