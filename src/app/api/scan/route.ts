import { NextResponse } from "next/server";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { matchDetectedCard, numberKey, cleanCardName } from "@/lib/pokemontcg";
import { searchTcgdex } from "@/lib/tcgdex";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage } from "@/lib/usage";
import { checkCredits } from "@/lib/credits";
import { createClient } from "@/lib/supabase/server";
import { rowToSummary, defaultVariantFor, type CardSummaryRow } from "@/lib/types";
import type { CardSummary, DetectedCard, ScanMatch } from "@/lib/types";
import { loadFinishOverrides } from "@/lib/finishFeedback";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 120; // vision + N lookups can take a while

// Field names here are TERSE ON PURPOSE — "num" not "collector_number".
//
// Unlike everywhere else in the app, the expensive half of a scan is what the
// model WRITES: output bills at five times input, and on a 20-card photo the
// answer is 78% of the cost. Every key is emitted once per card, so a
// four-token name costs four tokens twenty times over.
//
// The meaning lives in the `description` strings below, which stay long and
// explicit — those are input, at a fifth of the price, and they are what
// actually instructs the model. Shortening the keys costs nothing in
// grounding; shortening the descriptions would. `name` and `stamp` are left
// alone because they are already single tokens and clearer as they are.
const SCAN_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The card's printed name, exactly as shown (e.g. 'Charizard ex', 'Iono', 'Rare Candy').",
          },
          num: {
            type: ["string", "null"],
            description:
              "The collector number at the bottom of the card. Usually before a slash ('042' from '042/191'). Promo cards may have NO slash and a letter prefix instead — report the full code (e.g. 'SWSH095', 'SM210', 'XY67'). Null if unreadable.",
          },
          tot: {
            type: ["string", "null"],
            description:
              "What follows the slash: usually the set size ('191' from '042/191'), but on promo cards it can be a set code — report it as printed (e.g. 'SVP' from '095/SVP'). Null if there is no slash or it's unreadable.",
          },
          set: {
            type: ["string", "null"],
            description:
              "The set name if identifiable from the set symbol or printed text, else null.",
          },
          rar: {
            type: ["string", "null"],
            description:
              "Best guess at the printed rarity (e.g. 'Special Illustration Rare', 'Full Art', 'Common'). Null if unsure.",
          },
          fin: {
            type: "string",
            enum: ["normal", "holo", "reverse_holo", "unknown"],
            description:
              "The card's foil finish. 'holo': the ARTWORK window itself is foil/rainbow-shiny while the rest of the card is matte. 'reverse_holo': everything EXCEPT the artwork shines — the card body/borders are foil (often with an etched pattern) and the artwork is matte. 'normal': no foil anywhere. Full-art, ex/V/GX, and illustration-rare cards whose entire face is foil count as 'holo'. Use 'unknown' when glare, angle, or resolution makes it impossible to tell — do NOT guess.",
          },
          stamp: {
            type: "string",
            enum: ["none", "pokemon_center", "prerelease", "staff", "unknown"],
            description:
              "Gold foil promo stamp pressed onto the artwork area. 'pokemon_center': a gold Pokémon Center logo stamp. 'prerelease': a gold PRERELEASE wordmark. 'staff': a gold STAFF wordmark. 'none' when there is clearly no stamp; 'unknown' only if the artwork area is obscured.",
          },
          conf: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "high = name AND collector number clearly read; medium = name clear but number uncertain; low = partially obscured or blurry.",
          },
        },
        required: ["name", "num", "tot", "set", "rar", "fin", "stamp", "conf"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
} as const;

const SYSTEM = `You identify Pokémon Trading Card Game cards from photos.
The photo may contain a single card or many cards laid out (or a binder page).
For EVERY distinct, identifiable card in the image, extract its printed details.
Read carefully — the collector number at the bottom (e.g. 042/191) is the most
important field for identification. Promo cards are common and number differently:
a black-star promo may show 'SWSH095', 'SM210', 'XY67' with no slash (report the
full code in the "num" field), or '095/SVP' where the part after the slash is a
set code, not a count (report 'SVP' in "tot"). Do not invent numbers you
cannot read; use null instead and lower the confidence. Ignore card backs,
sleeves without cards, and anything that is not a Pokémon TCG card. List cards
roughly left-to-right, top-to-bottom.

FINISH — look carefully at WHERE the shine is, not just whether there is shine:
- HOLO: only the artwork window is foil (rainbow shimmer inside the picture
  frame); text box and borders are matte.
- REVERSE HOLO: the opposite — the artwork is matte while the rest of the card
  face shines, usually with an etched pattern (stars, Pokéballs, set motifs).
- Full-art / ex / illustration-rare cards that are foil edge-to-edge: holo.
- NORMAL is the default and the most common answer by far: most commons,
  uncommons, and trainers in a real collection are plain matte cardstock.
  Require positive evidence of foil — rainbow color shifts or an etched
  pattern — before answering holo or reverse_holo. Glossy cardstock catching
  the light, white hot-spots from the flash, sleeve shine, and washed-out
  photos are NOT foil. When you see shine but cannot see rainbow color or an
  etched pattern, answer 'normal' for common/uncommon cards and 'unknown'
  otherwise — never default to holo or reverse_holo on weak evidence.

STAMPS — check the artwork area of every card for small gold foil stamps: a
Pokémon Center logo, the word PRERELEASE, or the word STAFF. These are easy to
miss at small sizes — look twice on promo cards.`;

/** Check our own shared card cache before hitting the (slow) external APIs.
 *  Every card anyone has ever saved is in the cards table, so repeat scans of
 *  the same sets match instantly. Only accepts an unambiguous name+number
 *  match — anything uncertain falls through to the full external lookup. */
async function matchFromLocalDb(
  supabase: SupabaseClient,
  detected: DetectedCard
): Promise<CardSummary | null> {
  try {
    const key = numberKey(detected.collectorNumber);
    if (!detected.name || !key) return null;
    const { data } = await supabase
      .from("cards")
      .select("*")
      // Exact (case-insensitive) name match; strip ilike wildcards
      .ilike("name", detected.name.replace(/[%_]/g, ""))
      .limit(25);
    let hits = ((data ?? []) as CardSummaryRow[]).filter(
      (r) => numberKey(r.number) === key
    );
    // Same name+number can exist in several sets ("025/198" vs "025/159") —
    // use the printed set total to disambiguate when we read one.
    const totalText = detected.setTotal?.trim() ?? "";
    if (/^\d+$/.test(totalText)) {
      const total = parseInt(totalText, 10);
      hits = hits.filter((r) => r.set_printed_total === total);
    }
    return hits.length === 1 ? rowToSummary(hits[0]) : null;
  } catch {
    return null; // any local hiccup → just use the external APIs
  }
}

export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { image, mediaType } = (await req.json()) as {
      image?: string;
      mediaType?: string;
    };
    if (!image) {
      return NextResponse.json({ error: "Missing image" }, { status: 400 });
    }

    const supabase = await createClient();
    const budget = await checkCredits(user, profile);
    if (!budget.ok) {
      return NextResponse.json({ error: budget.message }, { status: 429 });
    }
    const client = anthropic();
    // Streamed with a generous cap: thinking + per-card JSON both draw from
    // max_tokens, and big multi-card spreads need the headroom.
    const stream = client.messages.stream({
      model: SCAN_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: SCAN_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (mediaType as "image/jpeg" | "image/png" | "image/webp") ?? "image/jpeg",
                data: image,
              },
            },
            {
              type: "text",
              text: "Identify every Pokémon card in this photo.",
            },
          ],
        },
      ],
    });
    const response = await stream.finalMessage();

    await logAiUsage(supabase, user.id, "scan", SCAN_MODEL, response.usage);

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The image could not be processed. Try a different photo." },
        { status: 422 }
      );
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json(
        {
          error:
            response.stop_reason === "max_tokens"
              ? "That photo has too many cards for one scan — try splitting it into two photos."
              : "No cards detected.",
        },
        { status: 422 }
      );
    }

    let parsed: {
      cards: Array<{
        name: string;
        num: string | null;
        tot: string | null;
        set: string | null;
        rar: string | null;
        fin?: "normal" | "holo" | "reverse_holo" | "unknown";
        stamp?: "none" | "pokemon_center" | "prerelease" | "staff" | "unknown";
        conf: "high" | "medium" | "low";
      }>;
    };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return NextResponse.json(
        {
          error:
            response.stop_reason === "max_tokens"
              ? "That photo has too many cards for one scan — try splitting it into two photos."
              : "The scan came back malformed — please try again.",
        },
        { status: 422 }
      );
    }
    // Match each detected card against the reference database (in parallel,
    // capped to avoid hammering the API).
    const detectedCards: DetectedCard[] = parsed.cards.map((c) => {
      // Fold the structured finish/stamp decisions into the hint string the
      // finish-defaulting logic keys on ("matte", not "non-holo" — that
      // substring would false-match the holo check).
      const hintParts: string[] = [];
      if (c.stamp === "pokemon_center") hintParts.push("Pokémon Center stamp");
      else if (c.stamp === "prerelease") hintParts.push("Prerelease stamp");
      else if (c.stamp === "staff") hintParts.push("Staff stamp");
      if (c.fin === "reverse_holo") hintParts.push("Reverse Holo");
      else if (c.fin === "holo") hintParts.push("Holo");
      else if (c.fin === "normal") hintParts.push("matte");
      if (c.rar) hintParts.push(c.rar);
      return {
        // Normalize away curly apostrophes etc. the vision model may emit
        name: cleanCardName(c.name),
        collectorNumber: c.num,
        setTotal: c.tot,
        setNameHint: c.set,
        rarityHint: hintParts.length > 0 ? hintParts.join(", ") : null,
        confidence: c.conf,
      };
    });

    const results: ScanMatch[] = [];
    const BATCH = 4;
    for (let i = 0; i < detectedCards.length; i += BATCH) {
      const batch = detectedCards.slice(i, i + BATCH);
      const matched = await Promise.all(
        batch.map(async (detected) => {
          // Fast path: a card someone already saved matches from our own
          // database in one quick query instead of several external calls.
          const local = await matchFromLocalDb(supabase, detected);
          if (local) {
            return { detected, match: local, candidates: [local] } satisfies ScanMatch;
          }

          let { match, candidates } = await matchDetectedCard(detected);

          // Consult TCGdex when the primary DB found nothing — or found only
          // cards that DON'T carry the detected collector number. That second
          // case is the typical promo failure: a name search surfaces old
          // printings of the same Pokémon while the actual promo exists only
          // in TCGdex (which gets new sets/promos months earlier).
          const key = numberKey(detected.collectorNumber);
          const primaryHasNumber =
            !key || candidates.some((c) => numberKey(c.number) === key);
          if (detected.name && (candidates.length === 0 || !primaryHasNumber)) {
            const alt = await searchTcgdex({
              name: detected.name,
              number: detected.collectorNumber ?? undefined,
              pageSize: 6,
            });
            const altNumberMatches = key
              ? alt.filter((c) => numberKey(c.number) === key)
              : alt;
            if (altNumberMatches.length > 0) {
              // Number-exact fallback wins; keep primary results as alternatives
              match = altNumberMatches[0];
              candidates = [...altNumberMatches, ...candidates];
            } else if (candidates.length === 0 && alt.length > 0) {
              match = alt[0];
              candidates = alt;
            }
          }
          return { detected, match, candidates } satisfies ScanMatch;
        })
      );
      results.push(...matched);
    }

    // Apply the scanner's learned finish memory: if this exact guess on this
    // exact card has been corrected by members before, suggest the corrected
    // finish instead of repeating the mistake.
    try {
      const matchedIds = results.filter((r) => r.match).map((r) => r.match!.id);
      const override = await loadFinishOverrides(supabase, matchedIds);
      for (const r of results) {
        if (!r.match) continue;
        const predicted = defaultVariantFor(r.match, r.detected.rarityHint);
        const learned = override(r.match.id, predicted);
        if (learned) r.suggestedVariant = learned;
      }
    } catch {
      // Memory is best-effort — a failure here never breaks a scan.
    }

    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("scan error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 500 }
    );
  }
}
