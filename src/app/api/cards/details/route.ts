import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { getBattleDataById, type CardBattleData } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";

export const maxDuration = 60;

/** What a deck card actually does, for reading it in the deck viewer. */
export interface CardDetail {
  id: string | null;
  name: string;
  image: string | null;
  supertype: string | null;
  subtypes: string[];
  types: string[];
  hp: string | null;
  number: string | null;
  setName: string | null;
  rarity: string | null;
  attacks: Array<{ name: string; cost: string[]; damage: string; text: string | null }>;
  abilities: Array<{ name: string; text: string }>;
  rules: string[];
  stage: string | null;
  trainerType: string | null;
}

/** Same alternate spellings the image lookup uses — decks write "Basic
 *  Fighting Energy" where the card record says "Fighting Energy". */
function nameVariants(name: string): string[] {
  const out = [name];
  const stripped = name.replace(/^basic\s+/i, "").trim();
  if (stripped && stripped !== name) out.push(stripped);
  if (/energy$/i.test(name) && !/^basic\s/i.test(name)) out.push(`Basic ${name}`);
  return out;
}

function toDetail(row: Record<string, unknown>, requestedName: string): CardDetail {
  const bd = (row.battle_data as CardBattleData | null) ?? null;
  return {
    id: (row.id as string) ?? null,
    name: (row.name as string) ?? requestedName,
    image: (row.image_small as string | null) ?? null,
    supertype: (row.supertype as string | null) ?? null,
    subtypes: (row.subtypes as string[] | null) ?? [],
    types: (row.types as string[] | null) ?? [],
    hp: (row.hp as string | null) ?? (bd?.hp != null ? String(bd.hp) : null),
    number: (row.number as string | null) ?? null,
    setName: (row.set_name as string | null) ?? null,
    rarity: (row.rarity as string | null) ?? null,
    attacks: bd?.attacks ?? [],
    abilities: bd?.abilities ?? [],
    rules: bd?.rules ?? [],
    stage: bd?.stage ?? null,
    trainerType: bd?.trainerType ?? null,
  };
}

/** GET ?ids=a,b&names=x,y — the printed text of cards in a deck.
 *
 *  Reads cards.battle_data, the same cache battles use, so the common case
 *  is a single database round-trip. Cards that have never been looked up get
 *  filled in from the card databases here (no AI, capped per request) and
 *  cached, so the next reader — including a battle — gets it for free. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const ids = [
      ...new Set(
        (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      ),
    ].slice(0, 80);
    const names = [
      ...new Set(
        (url.searchParams.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      ),
    ].slice(0, 80);
    if (ids.length === 0 && names.length === 0) {
      return NextResponse.json({ byId: {}, byName: {} });
    }

    const supabase = await createClient();
    // select("*") — battle_data only exists after migration 019, and naming
    // the column would fail the whole query on an older database.
    const rows: Array<Record<string, unknown>> = [];
    if (ids.length > 0) {
      const { data } = await supabase.from("cards").select("*").in("id", ids);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    const nameRows: Array<Record<string, unknown>> = [];
    if (names.length > 0) {
      const variants = [...new Set(names.flatMap(nameVariants))];
      const { data } = await supabase.from("cards").select("*").in("name", variants).limit(300);
      nameRows.push(...((data ?? []) as Array<Record<string, unknown>>));
    }

    // Fill in anything we've never fetched combat text for. Capped so a big
    // deck can't turn one page view into fifty API calls; whatever isn't
    // covered this time is covered next time, or by the nightly warm-up.
    const missing = [...rows, ...nameRows].filter(
      (r) => "battle_data" in r && !r.battle_data && typeof r.id === "string"
    );
    if (missing.length > 0) {
      const admin = createAdminClient();
      for (const row of missing.slice(0, 10)) {
        const id = row.id as string;
        try {
          const bd = id.startsWith("tcgdex-")
            ? await getTcgdexBattleDataById(id)
            : id.startsWith("custom-")
              ? null
              : await getBattleDataById(id);
          if (!bd) continue;
          row.battle_data = bd;
          await admin.from("cards").update({ battle_data: bd }).eq("id", id).then(() => {});
        } catch {
          // A card database being down costs this card's text, nothing more.
        }
      }
    }

    const byId: Record<string, CardDetail> = {};
    for (const row of rows) byId[row.id as string] = toDetail(row, String(row.name ?? ""));

    // Prefer a row that actually carries text when a name matches several
    // printings — reprints share wording, and an empty one helps nobody.
    const byName: Record<string, CardDetail> = {};
    const score = (r: Record<string, unknown>) => {
      const bd = r.battle_data as CardBattleData | null;
      if (!bd) return 0;
      return (bd.attacks?.length ?? 0) + (bd.rules?.length ?? 0) + (bd.abilities?.length ?? 0) > 0
        ? 2
        : 1;
    };
    for (const name of names) {
      const wanted = new Set(nameVariants(name).map((n) => n.toLowerCase()));
      const matches = nameRows.filter((r) => wanted.has(String(r.name ?? "").toLowerCase()));
      if (matches.length === 0) continue;
      matches.sort((a, b) => score(b) - score(a));
      byName[name] = toDetail(matches[0], name);
    }

    return NextResponse.json({ byId, byName });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
