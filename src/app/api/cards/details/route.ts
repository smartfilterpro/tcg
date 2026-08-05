import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { getBattleDataById, type CardBattleData } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";
import { ensureCardText } from "@/lib/cardText";

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
  /** The three numbers that decide a trade in play. They were on the card
   *  row all along and simply weren't passed on, so a Pokémon's panel could
   *  tell you what it attacks for and not what it folds to. */
  weak: { type: string; value: string } | null;
  resist: { type: string; value: string } | null;
  retreat: number | null;
  /** Why this card still has no text, when a read was attempted this
   *  request. Shown on the card's own panel: three rounds of guessing at why
   *  one Haunter wouldn't read were three rounds where the program knew and
   *  the screen didn't. */
  textError?: string | null;
  /** Has this card's own picture been read for its text — now or before?
   *
   *  So the screen can say what was actually tried instead of guessing. "No
   *  text on file" covers two different situations: nobody has looked yet,
   *  and everything available has been looked at and come back empty. Only
   *  one of those is worth waiting for. */
  triedPicture: boolean;
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
    weak: bd?.weak ?? null,
    resist: bd?.resist ?? null,
    retreat: bd?.retreat ?? null,
    triedPicture: row.__triedPicture === true || ((row.text_attempts as number | null) ?? 0) > 0,
    textError: (row.__textError as string | null) ?? null,
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
    const { user } = await requireUser();
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

    // ONE card asked for by id is somebody looking AT that card, and that is
    // the case allowed to read the picture.
    //
    // Every caller here used the free databases only, so a card they don't
    // carry stayed blank on the screen of the person actively asking about
    // it — while a battle would happily spend the read to answer the same
    // question. Opening a card is at least as deliberate as playing it. The
    // read happens once: the result is stored, and a failure is remembered
    // so an unreadable card isn't re-read on every visit.
    //
    // Deliberately NOT extended to the name path or to multi-card requests.
    // A deck warming 60 cards would be sixty vision reads, and a name can
    // match several printings — reading a picture picked at random from
    // those is a cost with no matching benefit.
    const singleId = ids.length === 1 && names.length === 0 ? ids[0] : null;
    // "Try reading it again", from the card's own panel. Only meaningful for
    // a single card, and it skips both the cool-off and the text we already
    // hold — the whole point is to redo a read whose result was wrong or
    // whose failure is now believed to be fixable.
    const force = singleId != null && url.searchParams.get("force") === "1";
    const toFill = force ? rows.filter((r) => r.id === singleId) : missing;
    if (toFill.length > 0) {
      const admin = createAdminClient();
      for (const row of toFill.slice(0, 10)) {
        const wantsVision = singleId != null && row.id === singleId;
        if (wantsVision) row.__triedPicture = true;
        try {
          const bd = await ensureCardText(
            admin,
            row as Parameters<typeof ensureCardText>[1],
            wantsVision
              ? {
                  allowVision: true,
                  userId: user.id,
                  force,
                  // First reason wins: it is the one nearest the cause.
                  report: (reason: string) => {
                    row.__textError ??= reason;
                  },
                }
              : undefined
          );
          if (!bd) continue;
          row.battle_data = bd;
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
