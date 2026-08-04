import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthError } from "@/lib/auth";
import { BattleError, type BattleCard } from "@/lib/battle";
import { getBattleDataById, type CardBattleData } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/usage";
import type { Deck, Profile } from "@/lib/types";
import { readCardTextOnce } from "@/lib/cardText";

/** AI card reader: for cards NO database knows (photo-scanned customs),
 *  read the card's own picture once and extract its battle data. Cached in
 *  cards.battle_data forever — battles themselves never call AI. */

/** AI effect compiler: turns a Trainer card's printed text into a tiny op
 *  script the referee can execute — ONCE per unique card, ever. The result
 *  is cached in cards.battle_data.fx, so battles themselves never call AI. */
const FX_MODEL = "claude-haiku-4-5-20251001";

const FX_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["draw", "millDeck", "heal", "searchDeckToHand", "shuffleHandIntoDeckDraw", "manual"],
          },
          n: { type: ["integer", "null"] },
          note: { type: ["string", "null"] },
        },
        required: ["op", "n", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
} as const;

const FX_SYSTEM = `You convert one Pokémon TCG Trainer card's printed text into a tiny JSON
effect script a battle app executes for the player who played the card.

Allowed ops:
- draw {n}: draw n cards
- millDeck {n}: discard the top n cards of YOUR OWN deck
- heal {n}: heal n damage from your Active Pokémon
- searchDeckToHand {n, note}: search your deck for card(s) — interactive, the
  app opens a deck-search picker; note says what to search for
- shuffleHandIntoDeckDraw {n}: shuffle your hand into your deck, draw n
- manual {note}: anything else — coin flips, effects on the opponent,
  switching, damage, conditions, "you may" choices. Short imperative note.

Rules: at most 3 ops, in card order. Only use a concrete op when the card
text states that effect unconditionally for the player. Anything conditional
("flip a coin", "if", "you may") or targeting the opponent → manual. When
unsure → manual.`;

async function compileTrainerFx(
  cardName: string,
  rules: string[],
  userId: string | null,
  admin: SupabaseClient
): Promise<CardBattleData["fx"]> {
  try {
    const client = anthropic();
    const response = await client.messages.create({
      model: FX_MODEL,
      max_tokens: 500,
      system: FX_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: FX_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        { role: "user", content: `Card: "${cardName}"\nText: ${rules.join(" / ")}` },
      ],
    });
    if (userId) await logAiUsage(admin, userId, "card_fx", FX_MODEL, response.usage);
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    const parsed = JSON.parse(text.text) as { ops?: Array<{ op: string; n?: number | null; note?: string | null }> };
    if (!Array.isArray(parsed.ops)) return null;
    return {
      ops: parsed.ops.slice(0, 3).map((o) => ({
        op: String(o.op),
        ...(typeof o.n === "number" ? { n: o.n } : {}),
        ...(o.note ? { note: String(o.note).slice(0, 160) } : {}),
      })),
    };
  } catch {
    return null; // no fx this time — retried on a future battle
  }
}

export const MIGRATION_HINT =
  "Battles need a one-time database update — run supabase/migrations/017_battles.sql in the Supabase SQL Editor.";

export function isMissingBattlesTable(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? "";
  return /battles/.test(msg) && /(does not exist|not find|schema cache)/i.test(msg);
}

export function displayName(profile: Profile | null, fallbackEmail?: string | null): string {
  return (
    profile?.display_name?.trim() ||
    (profile?.email ?? fallbackEmail ?? "Trainer").split("@")[0]
  );
}

/** Expand a saved deck into individual card instances with images.
 *  Cards are looked up by card_id when the deck stored one, otherwise by
 *  name (best effort — a missing image just renders as a name tile). */
export async function expandDeck(
  admin: SupabaseClient,
  deck: Deck,
  uidPrefix: string,
  opts?: { userId?: string }
): Promise<BattleCard[]> {
  const entries = (deck.cards ?? []).filter((e) => e?.name && (e.quantity ?? 0) > 0);
  if (entries.length === 0) throw new BattleError("That deck has no cards in it.");

  interface CardMeta {
    id: string | null;
    image: string | null;
    big: string | null;
    cat: "pokemon" | "trainer" | "energy" | null;
    basic: boolean | null;
    sup: boolean;
    stad: boolean;
    hp: number | null;
    types: string[];
    bd: CardBattleData | null;
    hasBdColumn: boolean;
    /** Failed vision reads, so an unreadable card is not retried every
     *  battle. Undefined before migration 050. */
    textAttempts?: number | null;
    textFailedAt?: string | null;
  }
  const rowToMeta = (row: Record<string, unknown>): CardMeta => {
    const supertype = ((row.supertype as string | null) ?? "").toLowerCase();
    const subtypes = ((row.subtypes as string[] | null) ?? []).map((s) => s.toLowerCase());
    const hpNum = parseInt((row.hp as string | null) ?? "", 10);
    return {
      id: (row.id as string | null) ?? null,
      image: (row.image_small as string | null) ?? null,
      big: (row.image_large as string | null) ?? null,
      cat: supertype.includes("pok")
        ? "pokemon"
        : supertype.includes("trainer")
          ? "trainer"
          : supertype.includes("energy")
            ? "energy"
            : null,
      // Empty subtypes = UNKNOWN stage, not "evolution" — TCGdex/custom
      // cards often have no subtypes, and guessing false blocked benching
      // Basics like Regirock.
      basic: supertype.includes("pok")
        ? subtypes.length > 0
          ? subtypes.includes("basic")
          : null
        : null,
      sup: subtypes.includes("supporter"),
      stad: subtypes.includes("stadium"),
      hp: Number.isFinite(hpNum) && hpNum > 0 ? hpNum : null,
      types: (row.types as string[] | null) ?? [],
      bd: (row.battle_data as CardBattleData | null) ?? null,
      hasBdColumn: "battle_data" in row,
      textAttempts: (row.text_attempts as number | null) ?? null,
      textFailedAt: (row.text_failed_at as string | null) ?? null,
    };
  };

  // select("*") — battle_data only exists after migration 019, and naming a
  // missing column would fail the whole lookup.
  const ids = [...new Set(entries.map((e) => e.card_id).filter(Boolean))] as string[];
  const metaById = new Map<string, CardMeta>();
  if (ids.length > 0) {
    const { data } = await admin.from("cards").select("*").in("id", ids);
    for (const row of data ?? []) metaById.set(row.id as string, rowToMeta(row));
  }

  const metaByName = new Map<string, CardMeta | null>();
  const unnamed = [
    ...new Set(
      entries
        .filter((e) => !e.card_id || !metaById.get(e.card_id))
        .map((e) => e.name)
    ),
  ].slice(0, 25);
  for (const name of unnamed) {
    // Try the exact name, then basic-energy aliases ("Basic Fighting
    // Energy" ↔ "Fighting Energy") — decks and card records disagree here.
    const variants = [name];
    const stripped = name.replace(/^basic\s+/i, "").trim();
    if (stripped && stripped !== name) variants.push(stripped);
    if (/energy$/i.test(name) && !/^basic\s/i.test(name)) variants.push(`Basic ${name}`);
    let meta: CardMeta | null = null;
    for (const variant of variants) {
      const { data } = await admin
        .from("cards")
        .select("*")
        .ilike("name", variant.replace(/[%_]/g, ""))
        .not("image_small", "is", null)
        .limit(1);
      if (data?.[0]) {
        meta = rowToMeta(data[0]);
        break;
      }
    }
    // No record with an image — take one without (combat data and category
    // still matter even when there's no art to show).
    if (!meta) {
      for (const variant of variants) {
        const { data } = await admin
          .from("cards")
          .select("*")
          .ilike("name", variant.replace(/[%_]/g, ""))
          .limit(1);
        if (data?.[0]) {
          meta = rowToMeta(data[0]);
          break;
        }
      }
    }
    metaByName.set(name, meta);
  }

  // Backfill card knowledge (attacks/weakness/retreat for Pokémon, printed
  // rules text for Trainers & Special Energy) — one fetch per card, ever,
  // routed by source: primary DB ids → pokemontcg.io, tcgdex- ids → TCGdex,
  // custom- ids (photo scans) → AI reads the card's own picture once.
  // Include name-resolved cards too (deck entries without a card_id) —
  // they were skipped before, which left their Pokémon without attacks.
  const allMetas = [
    ...metaById.values(),
    ...[...metaByName.values()].filter((m): m is NonNullable<typeof m> => m != null),
  ];
  const needsBd = allMetas.filter((m) => !m.bd && m.cat !== null && m.id);
  const primary = needsBd.filter(
    (m) => !m.id!.startsWith("custom-") && !m.id!.startsWith("tcgdex-")
  );
  const viaTcgdex = needsBd.filter((m) => m.id!.startsWith("tcgdex-"));
  // ANY card with a picture and no text, not just photo scans.
  //
  // This was gated on the id starting with "custom-", which excluded every
  // card the free databases don't describe — promo bundles, brand-new sets,
  // the printings only TCGplayer sells. Those have a real picture and no
  // text, which is exactly the case a vision read exists for; the id prefix
  // was standing in for "we have no other source" and getting it wrong.
  //
  // Still last, still capped: it runs only for cards the two free lookups
  // above left empty, and vision reads are the priciest thing here.
  const viaAi = needsBd
    .filter((m) => (m.big || m.image) && !primary.includes(m) && !viaTcgdex.includes(m))
    .slice(0, 4);

  const persistBd = async (m: (typeof needsBd)[number]) => {
    if (m.bd && m.hasBdColumn) {
      await admin.from("cards").update({ battle_data: m.bd }).eq("id", m.id!).then(() => {});
    }
  };
  const BD_BATCH = 5;
  for (let i = 0; i < Math.min(primary.length, 25); i += BD_BATCH) {
    await Promise.all(
      primary.slice(i, i + BD_BATCH).map(async (m) => {
        m.bd = await getBattleDataById(m.id!);
        await persistBd(m);
      })
    );
  }
  for (let i = 0; i < Math.min(viaTcgdex.length, 25); i += BD_BATCH) {
    await Promise.all(
      viaTcgdex.slice(i, i + BD_BATCH).map(async (m) => {
        m.bd = await getTcgdexBattleDataById(m.id!);
        await persistBd(m);
      })
    );
  }
  // The free sources have had their turn by now, so anything still without
  // text and holding a picture joins the queue — that is the card whose
  // database simply doesn't carry it.
  const stillEmpty = [...primary, ...viaTcgdex]
    .filter((m) => !m.bd && (m.big || m.image))
    .slice(0, 4);
  for (const m of stillEmpty) if (!viaAi.includes(m)) viaAi.push(m);

  for (let i = 0; i < viaAi.length; i += 2) {
    await Promise.all(
      viaAi.slice(i, i + 2).map(async (m) => {
        // Same read, same memory. A card the model cannot make out was
        // being re-read at the start of every battle it appeared in.
        m.bd = await readCardTextOnce(
          admin,
          {
            id: m.id!,
            image_large: m.big,
            image_small: m.image,
            text_attempts: m.textAttempts,
            text_failed_at: m.textFailedAt,
          },
          opts?.userId ?? null
        );
      })
    );
  }

  // Let battle data fill gaps the cards row couldn't answer: stage →
  // Basic/evolution, HP, and Supporter/Stadium flags.
  for (const m of allMetas) {
    if (!m.bd) continue;
    if (m.basic == null && m.bd.stage) m.basic = /basic/i.test(m.bd.stage);
    if (m.hp == null && m.bd.hp) m.hp = m.bd.hp;
    if (m.bd.trainerType) {
      if (/supporter/i.test(m.bd.trainerType)) m.sup = true;
      if (/stadium/i.test(m.bd.trainerType)) m.stad = true;
    }
  }

  // AI effect compile for Trainers that have text but no fx yet — Haiku,
  // once per unique card, cached forever. A failed compile just retries on
  // a future battle; the card stays fully playable manually either way.
  const needsFx = [...metaById.values()]
    .filter((m) => m.cat === "trainer" && m.bd?.rules?.length && m.bd.fx === undefined)
    .slice(0, 8);
  const FX_BATCH = 4;
  for (let i = 0; i < needsFx.length; i += FX_BATCH) {
    await Promise.all(
      needsFx.slice(i, i + FX_BATCH).map(async (m) => {
        const entry = entries.find((e) => e.card_id === m.id);
        const fx = await compileTrainerFx(entry?.name ?? "Trainer card", m.bd!.rules!, opts?.userId ?? null, admin);
        if (!fx) return;
        m.bd = { ...m.bd!, fx };
        if (m.hasBdColumn) {
          await admin.from("cards").update({ battle_data: m.bd }).eq("id", m.id!).then(() => {});
        }
      })
    );
  }

  const cards: BattleCard[] = [];
  entries.forEach((entry, i) => {
    const meta = (entry.card_id ? metaById.get(entry.card_id) : null) ?? metaByName.get(entry.name);
    const qty = Math.min(60, Math.max(1, Math.round(entry.quantity)));
    for (let c = 0; c < qty && cards.length < 100; c++) {
      cards.push({
        uid: `${uidPrefix}${i}-${c}`,
        name: entry.name,
        image: meta?.image ?? null,
        big: meta?.big ?? undefined,
        // The deck entry's own category is the fallback when the database
        // doesn't know the card (custom/manual entries).
        cat: meta?.cat ?? entry.category ?? null,
        basic: meta?.basic ?? null,
        sup: meta?.sup ?? false,
        stad: meta?.stad ?? false,
        hp: meta?.hp ?? null,
        types: meta?.types?.length ? meta.types : undefined,
        atk: meta?.bd?.attacks?.length ? meta.bd.attacks : undefined,
        weak: meta?.bd?.weak?.type ?? undefined,
        resist: meta?.bd?.resist?.type ?? undefined,
        retreat: meta?.bd?.retreat ?? undefined,
        rules: meta?.bd?.rules?.length ? meta.bd.rules : undefined,
        abilities: meta?.bd?.abilities?.length ? meta.bd.abilities : undefined,
        fx: meta?.bd?.fx ?? undefined,
      });
    }
  });
  if (cards.length < 7) {
    throw new BattleError("That deck is too small to battle with (needs at least 7 cards).");
  }
  return cards;
}

/** Load a deck the player may battle with: their own deck always, or a
 *  deck another member shared — but only when the battle allows borrowing. */
export async function loadBattleDeck(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
  allowShared: boolean
): Promise<{ deck: Deck; borrowed: boolean } | { error: string }> {
  const { data: own, error: ownErr } = await supabase
    .from("decks")
    .select("*")
    .eq("id", deckId)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) throw ownErr;
  if (own) return { deck: own as Deck, borrowed: false };

  // Not theirs — maybe a deck shared with them. Row-level security decides
  // visibility (everyone-scope, pals-only, or a direct share — migrations
  // 008 + 020), so no explicit shared filter here.
  const { data: shared, error: sharedErr } = await supabase
    .from("decks")
    .select("*")
    .eq("id", deckId)
    .maybeSingle();
  if (sharedErr) throw sharedErr;
  if (!shared) return { error: "Deck not found." };
  if (!allowShared) {
    return { error: "This battle doesn't allow shared decks — pick one of your own." };
  }
  return { deck: shared as Deck, borrowed: true };
}

// No ambiguous characters (0/O, 1/I/L) — codes get read out loud.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeBattleCode(): string {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function battleErrorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof BattleError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (isMissingBattlesTable(err)) {
    return NextResponse.json({ error: MIGRATION_HINT, migrated: false }, { status: 400 });
  }
  console.error("battles error", err);
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : "Request failed";
  return NextResponse.json({ error: message }, { status: 500 });
}
