import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthError } from "@/lib/auth";
import { BattleError, type BattleCard } from "@/lib/battle";
import { getBattleDataById, type CardBattleData } from "@/lib/pokemontcg";
import type { Deck, Profile } from "@/lib/types";

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
  uidPrefix: string
): Promise<BattleCard[]> {
  const entries = (deck.cards ?? []).filter((e) => e?.name && (e.quantity ?? 0) > 0);
  if (entries.length === 0) throw new BattleError("That deck has no cards in it.");

  interface CardMeta {
    id: string | null;
    image: string | null;
    cat: "pokemon" | "trainer" | "energy" | null;
    basic: boolean | null;
    sup: boolean;
    hp: number | null;
    types: string[];
    bd: CardBattleData | null;
    hasBdColumn: boolean;
  }
  const rowToMeta = (row: Record<string, unknown>): CardMeta => {
    const supertype = ((row.supertype as string | null) ?? "").toLowerCase();
    const subtypes = ((row.subtypes as string[] | null) ?? []).map((s) => s.toLowerCase());
    const hpNum = parseInt((row.hp as string | null) ?? "", 10);
    return {
      id: (row.id as string | null) ?? null,
      image: (row.image_small as string | null) ?? null,
      cat: supertype.includes("pok")
        ? "pokemon"
        : supertype.includes("trainer")
          ? "trainer"
          : supertype.includes("energy")
            ? "energy"
            : null,
      basic: supertype.includes("pok") ? subtypes.includes("basic") : null,
      sup: subtypes.includes("supporter"),
      hp: Number.isFinite(hpNum) && hpNum > 0 ? hpNum : null,
      types: (row.types as string[] | null) ?? [],
      bd: (row.battle_data as CardBattleData | null) ?? null,
      hasBdColumn: "battle_data" in row,
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
    metaByName.set(name, meta);
  }

  // Backfill combat stats (attacks/weakness/retreat) for Pokémon that don't
  // have them cached yet — one API fetch per card, ever. Custom and TCGdex
  // cards are skipped (no pokemontcg.io id); they fall back to manual damage.
  const needsBd = [...metaById.values()].filter(
    (m) =>
      m.cat === "pokemon" &&
      !m.bd &&
      m.id &&
      !m.id.startsWith("custom-") &&
      !m.id.startsWith("tcgdex-")
  );
  const BD_BATCH = 5;
  for (let i = 0; i < Math.min(needsBd.length, 20); i += BD_BATCH) {
    const batch = needsBd.slice(i, i + BD_BATCH);
    await Promise.all(
      batch.map(async (m) => {
        const bd = await getBattleDataById(m.id!);
        if (!bd) return;
        m.bd = bd;
        if (m.hasBdColumn) {
          // Cache for every future battle (best-effort).
          await admin
            .from("cards")
            .update({ battle_data: bd })
            .eq("id", m.id!)
            .then(() => {});
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
        // The deck entry's own category is the fallback when the database
        // doesn't know the card (custom/manual entries).
        cat: meta?.cat ?? entry.category ?? null,
        basic: meta?.basic ?? null,
        sup: meta?.sup ?? false,
        hp: meta?.hp ?? null,
        types: meta?.types?.length ? meta.types : undefined,
        atk: meta?.bd?.attacks?.length ? meta.bd.attacks : undefined,
        weak: meta?.bd?.weak?.type ?? undefined,
        resist: meta?.bd?.resist?.type ?? undefined,
        retreat: meta?.bd?.retreat ?? undefined,
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

  // Not theirs — maybe a shared deck (readable via the migration-008 policy).
  const { data: shared, error: sharedErr } = await supabase
    .from("decks")
    .select("*")
    .eq("id", deckId)
    .eq("shared", true)
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
