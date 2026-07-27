import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthError } from "@/lib/auth";
import { BattleError, type BattleCard } from "@/lib/battle";
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

  const ids = [...new Set(entries.map((e) => e.card_id).filter(Boolean))] as string[];
  const imageById = new Map<string, string | null>();
  if (ids.length > 0) {
    const { data } = await admin.from("cards").select("id, image_small").in("id", ids);
    for (const row of data ?? []) imageById.set(row.id as string, row.image_small as string | null);
  }

  const imageByName = new Map<string, string | null>();
  const unnamed = [
    ...new Set(
      entries
        .filter((e) => !e.card_id || !imageById.get(e.card_id))
        .map((e) => e.name)
    ),
  ].slice(0, 25);
  for (const name of unnamed) {
    const { data } = await admin
      .from("cards")
      .select("image_small")
      .ilike("name", name.replace(/[%_]/g, ""))
      .not("image_small", "is", null)
      .limit(1);
    imageByName.set(name, (data?.[0]?.image_small as string | null) ?? null);
  }

  const cards: BattleCard[] = [];
  entries.forEach((entry, i) => {
    const image =
      (entry.card_id ? imageById.get(entry.card_id) : null) ??
      imageByName.get(entry.name) ??
      null;
    const qty = Math.min(60, Math.max(1, Math.round(entry.quantity)));
    for (let c = 0; c < qty && cards.length < 100; c++) {
      cards.push({ uid: `${uidPrefix}${i}-${c}`, name: entry.name, image });
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
