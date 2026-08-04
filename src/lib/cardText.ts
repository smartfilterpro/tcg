// Reading a card's printed text off its own picture.
//
// The last resort, and for some cards the ONLY resort. Card text reaches the
// app from pokemontcg.io or TCGdex, and neither catalogues everything: promo
// bundles, brand-new sets and the printings only TCGplayer sells arrive with
// a name, a number, a price and a picture, and nothing about what the card
// does. Those rows sat with battle_data null for ever, because the two
// sources that could have filled it had never heard of the card.
//
// The picture is the card. A vision model transcribing it is not a guess in
// the way that recalling a card from training data is a guess — it is reading
// what is printed, from the same image a person would read it from. The
// prompt says transcribe, never invent, and readable=false is a real answer.
//
// Written to battle_data once and kept. One paid read per card, ever.
//
// This lived inside the battles module and was reachable only for cards whose
// id began with "custom-" — photo scans. Every other card that no free
// database describes was excluded by an id prefix rather than by anything
// about the card.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/usage";
import type { CardBattleData } from "@/lib/pokemontcg";

const CARD_READ_SCHEMA = {
  type: "object",
  properties: {
    readable: { type: "boolean", description: "False if the image is too blurry/small to read the card's text reliably." },
    category: { type: "string", enum: ["pokemon", "trainer", "energy", "unknown"] },
    stage: {
      type: ["string", "null"],
      description: "For Pokémon: 'Basic', 'Stage 1', 'Stage 2', or the printed stage. Null otherwise.",
    },
    hp: { type: ["integer", "null"] },
    attacks: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          cost_count: { type: "integer", description: "Number of energy symbols in the attack cost." },
          damage: { type: "string", description: "Printed damage, e.g. '80', '30+', '20×', or '' for none." },
          text: { type: ["string", "null"] },
        },
        required: ["name", "cost_count", "damage", "text"],
        additionalProperties: false,
      },
    },
    abilities: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: { name: { type: "string" }, text: { type: "string" } },
        required: ["name", "text"],
        additionalProperties: false,
      },
    },
    rules_text: {
      type: "array",
      maxItems: 4,
      items: { type: "string" },
      description: "Trainer/Special Energy effect text, exactly as printed.",
    },
    retreat: { type: ["integer", "null"] },
    weakness_type: { type: ["string", "null"] },
    trainer_type: { type: ["string", "null"], enum: ["Supporter", "Item", "Stadium", "Tool", null] },
  },
  required: [
    "readable", "category", "stage", "hp", "attacks", "abilities",
    "rules_text", "retreat", "weakness_type", "trainer_type",
  ],
  additionalProperties: false,
} as const;

const CARD_READ_SYSTEM = `You read a single Pokémon TCG card from its photo and
transcribe its printed game data EXACTLY — name of attacks, energy-symbol
counts, damage numbers, ability and effect text word for word. Do not guess
values you cannot read; use null (or readable=false if the whole card is
illegible). Transcribe, never invent.`;

export async function readCardFromImage(
  imageUrl: string,
  userId: string | null,
  admin: SupabaseClient
): Promise<CardBattleData | null> {
  try {
    const client = anthropic();
    const response = await client.messages.create({
      model: SCAN_MODEL,
      max_tokens: 2000,
      system: CARD_READ_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: CARD_READ_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            { type: "text", text: "Transcribe this card's game data." },
          ],
        },
      ],
    });
    if (userId) await logAiUsage(admin, userId, "card_fx", SCAN_MODEL, response.usage);
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    const read = JSON.parse(block.text) as {
      readable: boolean;
      category: string;
      stage: string | null;
      hp: number | null;
      attacks: Array<{ name: string; cost_count: number; damage: string; text: string | null }>;
      abilities: Array<{ name: string; text: string }>;
      rules_text: string[];
      retreat: number | null;
      weakness_type: string | null;
      trainer_type: string | null;
    };
    if (!read.readable) return null;
    return {
      attacks: (read.attacks ?? []).map((a) => ({
        name: a.name,
        cost: Array.from({ length: Math.max(0, Math.min(5, a.cost_count)) }, () => "Colorless"),
        damage: a.damage ?? "",
        text: a.text || null,
      })),
      weak: read.weakness_type ? { type: read.weakness_type, value: "×2" } : null,
      resist: null,
      retreat: read.retreat ?? 0,
      ...(read.rules_text?.length ? { rules: read.rules_text } : {}),
      ...(read.abilities?.length ? { abilities: read.abilities } : {}),
      stage: read.stage,
      hp: read.hp,
      trainerType: read.trainer_type,
    };
  } catch {
    return null;
  }
}

/** How many failed reads before a card is left alone for a while. */
const MAX_TEXT_ATTEMPTS = 2;

/** …and how long alone. A card unreadable today is unreadable tomorrow
 *  unless its picture changes, and pictures do change — the art mirror
 *  replaces thumbnails with full-size scans, and members upload their own.
 *  A week is long enough to stop the bleeding and short enough that a better
 *  image gets used. */
const TEXT_COOL_OFF_MS = 7 * 24 * 60 * 60 * 1000;

/** Read a card's text from its picture ONCE, and remember either outcome.
 *
 *  The plain reader returns null on failure and writes nothing, so the same
 *  unreadable card was re-read — and re-charged — on every question about
 *  it. And it is exactly the card that gets asked about repeatedly, because
 *  it never gains the text that would stop the asking.
 *
 *  Success is written to battle_data and the failure counters clear.
 *  Failure is counted, and a card that has failed twice is skipped until the
 *  cool-off passes. Returns null when it declines to try, which reads the
 *  same to a caller as a failure — the difference is that this one is free.
 *
 *  Bookkeeping is best-effort: migration 050 may not have run, and a missing
 *  column must not stop a read that would otherwise work. */
export async function readCardTextOnce(
  admin: SupabaseClient,
  card: { id: string; image_large?: string | null; image_small?: string | null;
          text_attempts?: number | null; text_failed_at?: string | null },
  userId: string | null
): Promise<CardBattleData | null> {
  const art = card.image_large ?? card.image_small;
  if (!art) return null;

  const attempts = card.text_attempts ?? 0;
  if (attempts >= MAX_TEXT_ATTEMPTS) {
    const failedAt = card.text_failed_at ? Date.parse(card.text_failed_at) : 0;
    if (Number.isFinite(failedAt) && Date.now() - failedAt < TEXT_COOL_OFF_MS) return null;
  }

  const bd = await readCardFromImage(art, userId, admin);

  try {
    if (bd) {
      await admin
        .from("cards")
        .update({ battle_data: bd, text_attempts: 0, text_failed_at: null })
        .eq("id", card.id);
    } else {
      await admin
        .from("cards")
        .update({ text_attempts: attempts + 1, text_failed_at: new Date().toISOString() })
        .eq("id", card.id);
    }
  } catch {
    // Migration 050 hasn't run. The read still counts; only the memory of
    // it is lost, and repeating a read is a smaller failure than refusing
    // to do one.
    if (bd) {
      await admin.from("cards").update({ battle_data: bd }).eq("id", card.id).then(() => {});
    }
  }

  return bd;
}
