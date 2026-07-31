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

export const BULK_BUCKET = "bulk-scans";
export const MAX_JOB_CARDS = 8000;

export interface BulkRead {
  name?: string;
  number?: string;
  set_name?: string;
  finish?: string;
  /** Catalogue id the read resolved to; null when nothing matched. */
  cardId?: string | null;
  cardName?: string | null;
  cardNumber?: string | null;
  cardSet?: string | null;
  error?: string;
}

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
      description: "The card's finish.",
    },
    readable: {
      type: "boolean",
      description: "False if the photo shows no readable card (blank, sleeve, misfeed).",
    },
  },
  required: ["name", "number", "set_name", "finish", "readable"],
} as const;

const READ_SYSTEM = `You read a single Pokémon TCG card from one photograph
taken by a card-feeding machine. The card fills most of the frame and may be
slightly rotated. Report exactly what is printed — name, collector number,
set if identifiable from the set symbol or bottom text, and finish. If the
photo does not show a readable card face (blank frame, card back, misfeed),
set readable=false.`;

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
      readable?: boolean;
    };
    if (parsed.readable === false) {
      return { error: "no readable card in the photo (misfeed?)" };
    }
    const read: BulkRead = {
      name: parsed.name ?? "",
      number: parsed.number ?? "",
      set_name: parsed.set_name ?? "",
      finish: parsed.finish ?? "normal",
    };
    return { ...read, ...(await matchCatalogue(admin, read)) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "read failed" };
  }
}

/** Same matching discipline as the CSV loader: exactly one catalogue card
 *  or nothing — a guessed printing would sail through as "verified" if the
 *  guess happened twice. */
async function matchCatalogue(
  admin: SupabaseClient,
  read: BulkRead
): Promise<Pick<BulkRead, "cardId" | "cardName" | "cardNumber" | "cardSet">> {
  const none = { cardId: null, cardName: null, cardNumber: null, cardSet: null };
  const name = (read.name ?? "").trim();
  if (!name) return none;
  const { data } = await admin
    .from("cards")
    .select("id, name, number, set_name")
    .ilike("name", `%${name.replace(/[%_]/g, " ")}%`)
    .limit(60);
  const wanted = normalizeForSearch(name);
  let hits = ((data ?? []) as Array<{ id: string; name: string; number: string; set_name: string | null }>)
    .filter((c) => normalizeForSearch(c.name) === wanted);
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
  // One survivor, or several records of the same physical card (sibling
  // sources spelling the set differently) — same name and number means the
  // same card, so the first is fine. Different numbers means ambiguity.
  if (hits.length === 0) return none;
  const keys = new Set(hits.map((c) => `${normalizeForSearch(c.name)}|${numberKey(c.number)}`));
  if (keys.size > 1) return none;
  const c = hits[0];
  return { cardId: c.id, cardName: c.name, cardNumber: c.number, cardSet: c.set_name };
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
      (p1.finish ?? "normal") === (p2.finish ?? "normal");
    const patch = agree
      ? {
          confidence: "verified",
          card_id: p1!.cardId,
          variant: p1!.finish ?? "normal",
          review_note: null,
          updated_at: new Date().toISOString(),
        }
      : {
          confidence: "review",
          card_id: p1?.cardId ?? p2?.cardId ?? null,
          variant: p1?.finish ?? p2?.finish ?? "normal",
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
