import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";
import { strictNumberKey } from "@/lib/pokemontcg";
import { buyLinkFor } from "@/lib/buyLink";
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
  buyUrl?: string;
}

export async function GET(req: Request) {
  try {
    const { user } = await requireUser();
    const url = new URL(req.url);
    const setName = url.searchParams.get("set")?.trim();
    const game = url.searchParams.get("game") === "mtg" ? "mtg" : "pokemon";
    const code = url.searchParams.get("code")?.trim().toLowerCase() || null;
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
    };
    const { data: catRows, error: catErr } = await fetchAllRows<CatRow>(() =>
      supabase
        .from("cards")
        .select("id, name, number, image_small, market_price, tcgplayer_id")
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
    const consider = (c: {
      id?: string;
      name: string;
      number: string;
      image: string | null;
      price: number | null;
      tcgplayerId: string | null;
    }) => {
      const key = strictNumberKey(c.number);
      if (!key) return;
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
              consider({
                name: c.name,
                number: c.collector_number,
                image: c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small ?? null,
                price: Number.isFinite(usd) ? usd : null,
                tcgplayerId: c.tcgplayer_id != null ? String(c.tcgplayer_id) : null,
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
      card: { id: string; set_name: string; number: string } | Array<{ id: string; set_name: string; number: string }> | null;
    };
    const { data: ownRows } = await fetchAllRows<OwnRow>(() =>
      supabase
        .from("collection_items")
        .select("card:cards(id, set_name, number)")
        .eq("user_id", user.id)
        .order("created_at")
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: OwnRow[] | null;
          error: { message: string } | null;
        }>;
      }
    );
    for (const r of ownRows ?? []) {
      const card = Array.isArray(r.card) ? r.card[0] : r.card;
      if (!card || card.set_name !== setName) continue;
      if ((card.id.startsWith("scry-") ? "mtg" : "pokemon") !== game) continue;
      const key = strictNumberKey(card.number);
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
    const cards = [...byNumber.values()]
      .map(({ hasTcgp: _h, ...c }) => c)
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
