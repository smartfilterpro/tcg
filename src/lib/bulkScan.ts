// The mail-in scanning service's brain: read one card photo, match it to
// the catalogue, pair the two passes, and decide who needs a human.
//
// Confidence is deliberately binary-by-agreement, not a probability the
// model reports about itself. A card is VERIFIED only when two independent
// photographs, taken on different passes through the feeder, both resolve
// to the same catalogue card. Everything else — disagreement, a failed
// read, a missing pass — is a review row. Self-reported model confidence
// is decoration; two matching reads of two different photos is evidence.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { estimateCostUsd, logAiUsage } from "@/lib/usage";
import { numberKey } from "@/lib/pokemontcg";
import { normalizeForSearch } from "@/lib/text";
import { pickPrinting } from "@/lib/cardPrinting";
import { defaultVariantFor, isSpecificPrinting } from "@/lib/types";

export const BULK_BUCKET = "bulk-scans";
export const MAX_JOB_CARDS = 8000;

export interface BulkRead {
  name?: string;
  number?: string;
  set_name?: string;
  finish?: string;
  /** The finish, pattern and stamp as one phrase — the same shape the phone
   *  scanner produces, so both feed the same finish rules. */
  hint?: string;
  /** The finish to SAVE, in the app's own vocabulary.
   *
   *  `finish` above is the model's enum — "reverse_holofoil" — and that was
   *  being written straight into collection_items.variant, where the app
   *  spells it "reverseHolofoil". So every reverse holo the machine scanned
   *  was stored under a key nothing else in the app recognises: no per-finish
   *  price, and a label rendered from the raw string. Converted once, here,
   *  where the card and the read are both in hand. */
  variant?: string;
  /** Catalogue id the read resolved to; null when nothing matched. */
  cardId?: string | null;
  cardName?: string | null;
  cardNumber?: string | null;
  cardSet?: string | null;
  error?: string;
}

/** Ball motifs, as the words a printing's name would use. Mirrors the phone
 *  scanner's map; both feed ballPatternOf. */
const BALL_WORDS: Record<string, string> = {
  poke_ball: "Poké Ball pattern",
  master_ball: "Master Ball pattern",
  friend_ball: "Friend Ball pattern",
  love_ball: "Love Ball pattern",
  other_ball: "Ball pattern",
};

const READ_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The card's printed name, exactly as printed." },
    number: {
      type: "string",
      description: "Collector number as printed, e.g. '050/191' or 'TG12/TG30'. Empty if unreadable.",
    },
    set_name: { type: "string", description: "Set name if identifiable, else empty." },
    finish: {
      type: "string",
      enum: ["normal", "holofoil", "reverse_holofoil"],
      description:
        "Where the shine is. 'holofoil': the ARTWORK window is foil and the rest is matte (or the whole card is foil, as on full arts and ex cards). 'reverse_holofoil': the opposite — matte artwork, shiny card body, usually with an etched repeating pattern. 'normal': no foil. Require positive evidence — rainbow colour shift or an etched pattern — before answering either foil value; glare from the rig's lights is not foil.",
    },
    pattern: {
      type: "string",
      enum: [
        "standard",
        "poke_ball",
        "master_ball",
        "friend_ball",
        "love_ball",
        "other_ball",
        "none",
        "unknown",
      ],
      description:
        "ONLY when finish is reverse_holofoil: which motif is etched into the foil, repeating across the card face. A ball motif ('poke_ball' / 'master_ball' / 'friend_ball' / 'love_ball', or 'other_ball' for one you can see but can't name) marks a separate, much rarer printing and must not be missed. 'standard' is the set's ordinary pattern — stars, set symbols, sparkle. 'none' when the card isn't reverse holo. 'unknown' when it is but the pattern can't be made out — never guess a ball.",
    },
    stamp: {
      type: "string",
      enum: ["none", "pokemon_center", "prerelease", "staff", "unknown"],
      description:
        "Gold foil stamp pressed onto the artwork: a Pokémon Center logo, the word PRERELEASE, or the word STAFF. 'none' when there is clearly none.",
    },
    readable: {
      type: "boolean",
      description: "False if the photo shows no readable card (blank, sleeve, misfeed).",
    },
  },
  required: ["name", "number", "set_name", "finish", "pattern", "stamp", "readable"],
} as const;

const READ_SYSTEM = `You read a single Pokémon TCG card from one photograph
taken by a card-feeding machine. The card fills most of the frame and may be
slightly rotated. Report exactly what is printed — name, collector number,
set if identifiable from the set symbol or bottom text, finish, reverse-holo
pattern, and any gold stamp. If the photo does not show a readable card face
(blank frame, card back, misfeed), set readable=false.

The card fills the frame, so you can see detail a phone snapshot of a whole
binder page cannot. Use it. The reverse-holo PATTERN is the field most worth
your attention: a Poké Ball, Master Ball, Friend Ball or Love Ball motif
repeating across the foil marks a different and far more valuable printing
than the same card with the set's ordinary star pattern, and the whole point
of this machine is that nobody has to check its work afterwards. Look at the
foil area specifically, not the artwork. If you genuinely cannot tell, say
'unknown' — that is a useful answer and a wrong ball is not.`;

/** Read one photo and resolve it against the catalogue. Charges the JOB,
 *  never a member: usage is logged under the admin who created the job with
 *  the bulk_scan endpoint tag, and the dollar cost is added to the job row
 *  for the service's own billing. */
export async function identifyPhoto(
  admin: SupabaseClient,
  jobId: string,
  adminUserId: string,
  image: { data: string; mediaType: string }
): Promise<BulkRead> {
  try {
    const client = anthropic();
    const res = await client.messages.create({
      model: SCAN_MODEL,
      max_tokens: 400,
      system: READ_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: READ_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType as "image/jpeg" | "image/png" | "image/webp",
                data: image.data,
              },
            },
            { type: "text", text: "Read this card." },
          ],
        },
      ],
    });

    await logAiUsage(admin, adminUserId, "bulk_scan", SCAN_MODEL, res.usage);
    const cost = estimateCostUsd(
      SCAN_MODEL,
      res.usage.input_tokens ?? 0,
      res.usage.output_tokens ?? 0
    );
    // Two writers can race here (both passes identify concurrently); the
    // increment is read-modify-write but a lost cent on a race is noise
    // next to the premium — correctness lives in ai_usage's rows.
    const { data: job } = await admin.from("bulk_jobs").select("ai_cost_usd").eq("id", jobId).maybeSingle();
    await admin
      .from("bulk_jobs")
      .update({ ai_cost_usd: Number(job?.ai_cost_usd ?? 0) + cost, updated_at: new Date().toISOString() })
      .eq("id", jobId);

    const block = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(block && block.type === "text" ? block.text : "{}") as {
      name?: string;
      number?: string;
      set_name?: string;
      finish?: string;
      pattern?: string;
      stamp?: string;
      readable?: boolean;
    };
    if (parsed.readable === false) {
      return { error: "no readable card in the photo (misfeed?)" };
    }
    // The same hint string the phone scanner builds, so both go through one
    // set of rules for what a finish and a pattern mean.
    const hintParts: string[] = [];
    if (parsed.stamp === "pokemon_center") hintParts.push("Pokémon Center stamp");
    else if (parsed.stamp === "prerelease") hintParts.push("Prerelease stamp");
    else if (parsed.stamp === "staff") hintParts.push("Staff stamp");
    if (parsed.finish === "reverse_holofoil") hintParts.push("Reverse Holo");
    else if (parsed.finish === "holofoil") hintParts.push("Holo");
    else hintParts.push("matte");
    if (parsed.finish === "reverse_holofoil") {
      const ball = BALL_WORDS[parsed.pattern ?? ""];
      if (ball) hintParts.push(ball);
    }
    const hint = hintParts.join(", ");

    const read: BulkRead = {
      name: parsed.name ?? "",
      number: parsed.number ?? "",
      set_name: parsed.set_name ?? "",
      finish: parsed.finish ?? "normal",
      hint,
    };
    return { ...read, ...(await matchCatalogue(admin, read, hint)) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "read failed" };
  }
}

/** Same matching discipline as the CSV loader: exactly one catalogue card
 *  or nothing — a guessed printing would sail through as "verified" if the
 *  guess happened twice. */
async function matchCatalogue(
  admin: SupabaseClient,
  read: BulkRead,
  hint: string
): Promise<Pick<BulkRead, "cardId" | "cardName" | "cardNumber" | "cardSet" | "variant">> {
  const none = {
    cardId: null,
    cardName: null,
    cardNumber: null,
    cardSet: null,
    variant: undefined,
  };
  const name = (read.name ?? "").trim();
  if (!name) return none;
  // rarity and prices come along because the finish is decided here — the
  // card's own printings are what make "reverse holo" mean something.
  const { data } = await admin
    .from("cards")
    .select("id, name, number, set_name, rarity, prices")
    .ilike("name", `%${name.replace(/[%_]/g, " ")}%`)
    .limit(60);
  const wanted = normalizeForSearch(name);
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    number: string;
    set_name: string | null;
    rarity: string | null;
    prices: Record<string, number | null> | null;
  }>;
  // Exact name, PLUS the printings of it.
  //
  // An exact-name filter is what keeps "Charizard" from matching "Charizard
  // ex", and it also excluded every row this machine was just taught to
  // look for: "Dragonair (Poké Ball Pattern)" is not "Dragonair". So the
  // read could report a Master Ball and the matcher had no Master Ball row
  // to give it. A name that is the read plus a parenthetical is the same
  // card in a different printing, and belongs in the candidates.
  let hits = rows.filter((c) => {
    const n = normalizeForSearch(c.name);
    return n === wanted || (n.startsWith(wanted) && isSpecificPrinting(c.name));
  });
  const printed = (read.number ?? "").split("/")[0].trim();
  if (printed) {
    const key = numberKey(printed);
    const byNumber = hits.filter((c) => numberKey(c.number) === key);
    if (byNumber.length > 0) hits = byNumber;
  }
  if (read.set_name && hits.length > 1) {
    const set = normalizeForSearch(read.set_name);
    const bySet = hits.filter((c) => normalizeForSearch(c.set_name ?? "").includes(set));
    if (bySet.length > 0) hits = bySet;
  }
  if (hits.length === 0) return none;
  // Different collector numbers still means ambiguity and still refuses.
  const keys = new Set(hits.map((c) => numberKey(c.number)));
  if (keys.size > 1) return none;

  // Same name and number is no longer one card: the sync creates a row per
  // printing, so a Poké Ball reverse holo has its own. Pick the one the
  // photo shows — the named printing when the read saw that ball, the plain
  // row when it saw none. A machine nobody checks afterwards must not file a
  // Master Ball reverse as the common version.
  const picked = pickPrinting(hits, hint);
  if (!picked) return none;
  return {
    cardId: picked.id,
    cardName: picked.name,
    cardNumber: picked.number,
    cardSet: picked.set_name,
    // In the app's vocabulary, and aware of the card: a printing that only
    // exists as a reverse holo can't be recorded as a plain one, and a row
    // that IS the Poké Ball printing takes its own finish rather than the
    // pattern label.
    variant: defaultVariantFor(picked, hint),
  };
}

export interface PairingResult {
  total: number;
  verified: number;
  review: number;
  pass1Count: number;
  pass2Count: number;
  aligned: boolean;
}

/** Pair pass 2 (reversed) onto pass 1 and set each row's confidence.
 *
 *  Alignment is strict: if the pass counts differ, ONE slipped card would
 *  shift every later pairing by one and manufacture a wall of false
 *  disagreements — so mismatched counts pair nothing and every row goes to
 *  review instead. Re-runnable until the job uploads. */
export async function finalizeJob(admin: SupabaseClient, jobId: string): Promise<PairingResult> {
  const { data } = await admin
    .from("bulk_cards")
    .select("id, seq, pass1_read, pass2_read, reviewed, confidence, card_id, variant")
    .eq("job_id", jobId)
    .order("seq");
  const rows = (data ?? []) as Array<{
    id: string;
    seq: number;
    pass1_read: BulkRead | null;
    pass2_read: BulkRead | null;
    reviewed: boolean;
    confidence: string | null;
  }>;

  const pass1Count = rows.filter((r) => r.pass1_read != null).length;
  const pass2Count = rows.filter((r) => r.pass2_read != null).length;
  const aligned = pass2Count > 0 && pass1Count === pass2Count;

  let verified = 0;
  let review = 0;
  for (const row of rows) {
    // A human's decision outlives re-finalizing.
    if (row.reviewed) {
      if (row.confidence !== "corrected") {
        await admin.from("bulk_cards").update({ confidence: "corrected" }).eq("id", row.id);
      }
      continue;
    }
    const p1 = row.pass1_read;
    const p2 = row.pass2_read;
    const agree =
      aligned &&
      p1?.cardId != null &&
      p2?.cardId != null &&
      p1.cardId === p2.cardId &&
      (p1.variant ?? p1.finish ?? "normal") === (p2.variant ?? p2.finish ?? "normal");
    const patch = agree
      ? {
          confidence: "verified",
          card_id: p1!.cardId,
          variant: p1!.variant ?? p1!.finish ?? "normal",
          review_note: null,
          updated_at: new Date().toISOString(),
        }
      : {
          confidence: "review",
          card_id: p1?.cardId ?? p2?.cardId ?? null,
          variant: p1?.variant ?? p1?.finish ?? p2?.variant ?? p2?.finish ?? "normal",
          review_note: !aligned
            ? pass2Count === 0
              ? "single pass — no verification photo"
              : "pass counts differ — pairing unsafe (misfeed?)"
            : p1?.error || p2?.error
              ? `read failed: ${p1?.error ?? p2?.error}`
              : p1?.cardId == null || p2?.cardId == null
                ? "no exact catalogue match"
                : p1.cardId !== p2.cardId
                  ? "passes disagree on the card"
                  : "passes disagree on the finish",
          updated_at: new Date().toISOString(),
        };
    await admin.from("bulk_cards").update(patch).eq("id", row.id);
    if (agree) verified++;
    else review++;
  }

  return { total: rows.length, verified, review, pass1Count, pass2Count, aligned };
}
