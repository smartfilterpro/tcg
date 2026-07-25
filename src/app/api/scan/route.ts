import { NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { matchDetectedCard } from "@/lib/pokemontcg";
import { requireUser, AuthError } from "@/lib/auth";
import type { DetectedCard, ScanMatch } from "@/lib/types";

export const maxDuration = 120; // vision + N lookups can take a while

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
          collector_number: {
            type: ["string", "null"],
            description:
              "The collector number at the bottom of the card. Usually before a slash ('042' from '042/191'). Promo cards may have NO slash and a letter prefix instead — report the full code (e.g. 'SWSH095', 'SM210', 'XY67'). Null if unreadable.",
          },
          set_total: {
            type: ["string", "null"],
            description:
              "What follows the slash: usually the set size ('191' from '042/191'), but on promo cards it can be a set code — report it as printed (e.g. 'SVP' from '095/SVP'). Null if there is no slash or it's unreadable.",
          },
          set_name_hint: {
            type: ["string", "null"],
            description:
              "The set name if identifiable from the set symbol or printed text, else null.",
          },
          rarity_hint: {
            type: ["string", "null"],
            description:
              "Best guess at rarity/finish from visual cues (e.g. 'Special Illustration Rare', 'Full Art', 'Holo', 'Common'). Null if unsure.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "high = name AND collector number clearly read; medium = name clear but number uncertain; low = partially obscured or blurry.",
          },
        },
        required: ["name", "collector_number", "set_total", "set_name_hint", "rarity_hint", "confidence"],
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
full code as collector_number), or '095/SVP' where the part after the slash is a
set code, not a count (report 'SVP' as set_total). Do not invent numbers you
cannot read; use null instead and lower the confidence. Ignore card backs,
sleeves without cards, and anything that is not a Pokémon TCG card. List cards
roughly left-to-right, top-to-bottom.`;

export async function POST(req: Request) {
  try {
    await requireUser();
    const { image, mediaType } = (await req.json()) as {
      image?: string;
      mediaType?: string;
    };
    if (!image) {
      return NextResponse.json({ error: "Missing image" }, { status: 400 });
    }

    const client = anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
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

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The image could not be processed. Try a different photo." },
        { status: 422 }
      );
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json({ error: "No cards detected." }, { status: 422 });
    }

    const parsed = JSON.parse(textBlock.text) as {
      cards: Array<{
        name: string;
        collector_number: string | null;
        set_total: string | null;
        set_name_hint: string | null;
        rarity_hint: string | null;
        confidence: "high" | "medium" | "low";
      }>;
    };

    // Match each detected card against the reference database (in parallel,
    // capped to avoid hammering the API).
    const detectedCards: DetectedCard[] = parsed.cards.map((c) => ({
      name: c.name,
      collectorNumber: c.collector_number,
      setTotal: c.set_total,
      setNameHint: c.set_name_hint,
      rarityHint: c.rarity_hint,
      confidence: c.confidence,
    }));

    const results: ScanMatch[] = [];
    const BATCH = 4;
    for (let i = 0; i < detectedCards.length; i += BATCH) {
      const batch = detectedCards.slice(i, i + BATCH);
      const matched = await Promise.all(
        batch.map(async (detected) => {
          const { match, candidates } = await matchDetectedCard(detected);
          return { detected, match, candidates } satisfies ScanMatch;
        })
      );
      results.push(...matched);
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
