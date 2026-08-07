import { NextResponse } from "next/server";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { matchDetectedCard, numberKey, cleanCardName } from "@/lib/pokemontcg";
import { searchTcgdex } from "@/lib/tcgdex";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage } from "@/lib/usage";
import { checkCredits } from "@/lib/credits";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createObjectScanner, isEnvelope } from "@/lib/jsonStream";
import { rowToSummary, defaultVariantFor, type CardSummaryRow } from "@/lib/types";
import { pickPrinting, patternPrintingFor } from "@/lib/cardPrinting";
import { setsAgree } from "@/lib/setName";
import type { CardSummary, DetectedCard, ScanMatch } from "@/lib/types";
import { loadFinishOverrides } from "@/lib/finishFeedback";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorJson, safeMessage } from "@/lib/apiError";
import { PublicError } from "@/lib/apiError";

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
    // FIRST on purpose. Emitted before the cards, so the progress bar has a
    // denominator while the reading is still happening rather than only once
    // it's finished. One integer, once — not per card — so the output cost
    // this file is otherwise so careful about is a rounding error.
    count: {
      type: "integer",
      description: "How many Pokémon cards are visible in the photo. Answer this first, before reading any of them.",
    },
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
          patt: {
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
              "ONLY meaningful when fin is 'reverse_holo': which motif is etched into the foil, repeating across the card face. 'poke_ball' / 'master_ball' / 'friend_ball' / 'love_ball': the foil is filled with repeated balls of that type — these are separate, rarer printings and worth telling apart. 'other_ball': clearly a repeating ball motif, but not one of those four. 'standard': the set's ordinary reverse pattern (stars, set symbols, generic sparkle). 'none' when the card is not reverse holo. 'unknown' when it is reverse holo but the pattern can't be made out — do NOT guess a ball.",
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
        required: ["name", "num", "tot", "set", "rar", "fin", "patt", "stamp", "conf"],
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

REVERSE-HOLO PATTERN — when, and only when, a card is reverse holo, look at
what is etched into the shiny part. Most cards show the set's ordinary motif:
stars, set symbols, generic sparkle. A few show a repeating BALL motif filling
the foil — Poké Balls, Master Balls, or Friend Balls — and those are separate,
much rarer printings, so they are worth reading carefully. The balls repeat in
a regular grid across the card face and are unmistakable once seen; if you
cannot make out what the pattern is, answer 'unknown' rather than guessing a
ball. Cards that are not reverse holo get 'none'.

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
    if (!detected.name) return null;
    const key = numberKey(detected.collectorNumber);
    const { data } = await supabase
      .from("cards")
      .select("*")
      // Exact (case-insensitive) name match; strip ilike wildcards
      .ilike("name", detected.name.replace(/[%_]/g, ""))
      .limit(25);
    const all = (data ?? []) as CardSummaryRow[];

    // NO NUMBER IS NOT NO ANSWER.
    //
    // This used to give up the moment the collector number came back
    // unreadable — which happens constantly on a photo of a pile, where the
    // bottom edge of a card is the first thing another card covers. Giving
    // up meant a card we have held for weeks went out to an external API
    // and, on a bad minute, spent forty seconds there while six other cards
    // waited behind it.
    //
    // A name we hold exactly, narrowed by the set if the scanner read one,
    // is a perfectly good answer when it leaves ONE collector number
    // standing. Two numbers means two different cards and it still goes
    // outside, which is the case the strictness was really for.
    if (!key) {
      let byName = all;
      const setHint = detected.setNameHint?.trim();
      if (setHint) {
        const bySet = byName.filter((r) => setsAgree(r.set_name, setHint));
        if (bySet.length > 0) byName = bySet;
      }
      const totalOnly = detected.setTotal?.trim() ?? "";
      if (/^\d+$/.test(totalOnly)) {
        const total = parseInt(totalOnly, 10);
        const byTotal = byName.filter(
          (r) => r.set_printed_total === total || r.set_printed_total == null
        );
        if (byTotal.length > 0) byName = byTotal;
      }
      const numbers = new Set(byName.map((r) => numberKey(r.number)));
      if (numbers.size !== 1) return null;
      const picked = pickPrinting(byName, detected.rarityHint);
      return picked ? rowToSummary(picked) : null;
    }

    let hits = all.filter((r) => numberKey(r.number) === key);
    // Same name+number can exist in several sets ("025/198" vs "025/159") —
    // use the printed set total to disambiguate when we read one. A set size
    // we don't hold can't refute anything, so it is only allowed to narrow.
    const totalText = detected.setTotal?.trim() ?? "";
    if (/^\d+$/.test(totalText)) {
      const total = parseInt(totalText, 10);
      const byTotal = hits.filter(
        (r) => r.set_printed_total === total || r.set_printed_total == null
      );
      if (byTotal.length > 0) hits = byTotal;
    }
    // Several rows sharing a name and a number is now NORMAL — the sync
    // creates a row per printing, so "Dragonair" is three cards. This used to
    // require exactly one candidate, so it failed on every card with
    // printings and went out to the external APIs for something sitting in
    // our own database. Choosing the right one keeps the fast path fast.
    const picked = pickPrinting(hits, detected.rarityHint);
    return picked ? rowToSummary(picked) : null;
  } catch {
    return null; // any local hiccup → just use the external APIs
  }
}

/** How long one card may spend on external lookups before the scan moves on.
 *
 *  A person is watching a spinner, and an unmatched card costs them one tap
 *  to fix. Twelve seconds is generous for two attempts at two query shapes
 *  and firmly bounded: seven cards can no longer add up to a minute because
 *  one of them was unlucky. */
const EXTERNAL_BUDGET_MS = 12_000;

/** Where a scan's time went, per stage and per card.
 *
 *  "It took 57 seconds" is not a diagnosis. The model reading the photo, the
 *  catalogue answering, and one card falling through to an external API
 *  having a bad minute are three different problems with three different
 *  fixes, and they are indistinguishable from a single total. Every scan now
 *  keeps its own split: what the model cost, what matching cost, and for each
 *  card which source answered and how long it took. */
export interface ScanTimings {
  modelMs: number;
  matchMs: number;
  totalMs: number;
  /** Which source answered, per card, with the time it took. */
  cards: Array<{ name: string; ms: number; path: string; swapped?: boolean }>;
}

/** Do the scan, recording progress against a job row.
 *
 *  Deliberately NOT tied to the request that started it. The model runs for
 *  ten to thirty seconds, and a phone that sleeps or a tab that backgrounds
 *  used to kill the fetch — while the model kept going and the credits were
 *  spent anyway. Someone paid for a scan and got an error. Now the work and
 *  the browser are independent: whatever happens to the connection, the
 *  cards land in the job and the client picks them up when it comes back. */
async function runScan(opts: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  image: string;
  mediaType: string | undefined;
  jobId: string;
  timings: ScanTimings;
}): Promise<ScanMatch[]> {
  const { supabase, admin, userId, image, mediaType, jobId, timings } = opts;
  const scanStartedAt = Date.now();
  {
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
    // Report each card the moment the model finishes writing it.
    //
    // The answer takes ten to thirty seconds and every card in it is complete
    // long before the message is. Without this the client knows nothing until
    // the end, which is why the old progress bar ran on a timer and invented
    // its own progress.
    if (jobId) {
      const scanner = createObjectScanner();
      const seen: Array<{ name: string; num: string | null; conf: string }> = [];
      let expected: number | null = null;

      stream.on("text", (chunk: string) => {
        for (const obj of scanner.push(chunk)) {
          const o = obj as Record<string, unknown>;
          if (isEnvelope(o)) {
            if (typeof o.count === "number") expected = o.count;
            continue;
          }
          // The count arrives on the envelope, which is last — but the model
          // may also emit it as a bare value we never see as an object. Take
          // it from whichever gets here first.
          if (typeof o.name !== "string") continue;
          seen.push({
            name: o.name,
            num: typeof o.num === "string" ? o.num : null,
            conf: typeof o.conf === "string" ? o.conf : "medium",
          });
          // Fire and forget: progress reporting must never slow the read or
          // fail the scan.
          void admin
            .from("scan_jobs")
            .update({
              cards: seen,
              // Until the model states a count, the best denominator we
              // have is what we've read so far — a bar that never claims
              // more progress than actually happened.
              expected: expected ?? seen.length,
              updated_at: new Date().toISOString(),
            })
            .eq("id", jobId)
            .then(() => {});
        }
      });
    }

    const response = await stream.finalMessage();

    await logAiUsage(supabase, userId, "scan", SCAN_MODEL, response.usage);

    // Thrown, not returned: nothing is listening to this call any more, so
    // the failure has to land on the job where the client will find it.
    if (response.stop_reason === "refusal") {
      throw new PublicError("The image could not be processed. Try a different photo.");
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        response.stop_reason === "max_tokens"
          ? "That photo has too many cards for one scan — try splitting it into two photos."
          : "No cards detected."
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
        patt?:
          | "standard"
          | "poke_ball"
          | "master_ball"
          | "friend_ball"
          | "love_ball"
          | "other_ball"
          | "none"
          | "unknown";
        stamp?: "none" | "pokemon_center" | "prerelease" | "staff" | "unknown";
        conf: "high" | "medium" | "low";
      }>;
    };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new Error(
        response.stop_reason === "max_tokens"
          ? "That photo has too many cards for one scan — try splitting it into two photos."
          : "The scan came back malformed — please try again."
      );
    }
    timings.modelMs = Date.now() - scanStartedAt;

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
      // The ball motif, only where it means something. A pattern reported on
      // a card that isn't reverse holo is the model answering a question it
      // wasn't being asked.
      const BALL_WORDS: Record<string, string> = {
        poke_ball: "Poké Ball pattern",
        master_ball: "Master Ball pattern",
        friend_ball: "Friend Ball pattern",
        love_ball: "Love Ball pattern",
        // A ball it recognised but couldn't name. Still enough to go looking
        // for the printing's own row, which is where the real price is.
        other_ball: "Ball pattern",
      };
      const ball = c.fin === "reverse_holo" ? (BALL_WORDS[c.patt ?? ""] ?? null) : null;
      if (ball) hintParts.push(ball);
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
    const matchStartedAt = Date.now();
    const BATCH = 4;
    for (let i = 0; i < detectedCards.length; i += BATCH) {
      const batch = detectedCards.slice(i, i + BATCH);
      const matched = await Promise.all(
        batch.map(async (detected) => {
          const cardStartedAt = Date.now();
          const note = (path: string, swapped?: boolean) =>
            timings.cards.push({
              name: detected.name,
              ms: Date.now() - cardStartedAt,
              path,
              ...(swapped ? { swapped: true } : {}),
            });

          // Fast path: a card someone already saved matches from our own
          // database in one quick query instead of several external calls.
          const local = await matchFromLocalDb(supabase, detected);
          if (local) {
            const swapped = await patternPrintingFor(supabase, local, detected.rarityHint);
            note("catalogue", !!swapped);
            return {
              detected,
              match: swapped ?? local,
              candidates: swapped ? [swapped, local] : [local],
            } satisfies ScanMatch;
          }

          // A budget for this card, not an open-ended wait. Four query
          // shapes with their own retry ladders is how one Lampent spent
          // 39.5 seconds while the rest of the scan waited: a batch finishes
          // when its slowest member does.
          let { match, candidates } = await matchDetectedCard(detected, {
            deadline: cardStartedAt + EXTERNAL_BUDGET_MS,
            timeoutMs: 8_000,
            attempts: 2,
          });
          let usedTcgdex = false;

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
              usedTcgdex = true;
            } else if (candidates.length === 0 && alt.length > 0) {
              match = alt[0];
              candidates = alt;
              usedTcgdex = true;
            }
          }
          let swappedHere = false;
          if (match) {
            const swapped = await patternPrintingFor(supabase, match, detected.rarityHint);
            if (swapped) {
              match = swapped;
              candidates = [swapped, ...candidates];
              swappedHere = true;
            }
          }
          // "no number read" is the difference between a card we couldn't
          // find and a card we never looked for. Both used to log the same.
          const why = numberKey(detected.collectorNumber) ? "" : " (no number read)";
          note(
            (match ? (usedTcgdex ? "tcgdex" : "pokemontcg") : "no match") + why,
            swappedHere
          );
          return { detected, match, candidates } satisfies ScanMatch;
        })
      );
      results.push(...matched);
    }

    // How many of each of these they already own.
    //
    // Answered here rather than by the client because we are already holding
    // the matched ids and the user's session — one query instead of a round
    // trip, and it means the results screen can say "×3 now" instead of
    // making someone remember.
    try {
      const ids = [...new Set(results.filter((r) => r.match).map((r) => r.match!.id))];
      if (ids.length > 0) {
        const { data: owned } = await supabase
          .from("collection_items")
          .select("card_id, quantity")
          .eq("user_id", userId)
          .in("card_id", ids);
        const countById = new Map<string, number>();
        for (const row of owned ?? []) {
          const id = row.card_id as string;
          countById.set(id, (countById.get(id) ?? 0) + ((row.quantity as number) ?? 0));
        }
        for (const r of results) {
          if (r.match) r.owned = countById.get(r.match.id) ?? 0;
        }
      }
    } catch {
      // Best-effort: a missing count shows as "new", which is the safe
      // reading — it never claims someone owns something they don't.
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

    timings.matchMs = Date.now() - matchStartedAt;
    timings.totalMs = Date.now() - scanStartedAt;

    // One line per scan, in the log an admin can read from a phone. The
    // per-source counts are the whole diagnosis: cards answered by our own
    // catalogue are instant, and anything else is a network round trip we
    // may be able to remove.
    const byPath = timings.cards.reduce<Record<string, number>>((acc, c) => {
      acc[c.path] = (acc[c.path] ?? 0) + 1;
      return acc;
    }, {});
    const slowest = [...timings.cards].sort((a, b) => b.ms - a.ms)[0];
    console.log(
      `scan ${jobId}: ${results.length} cards in ${(timings.totalMs / 1000).toFixed(1)}s ` +
        `(model ${(timings.modelMs / 1000).toFixed(1)}s, matching ${(timings.matchMs / 1000).toFixed(1)}s) · ` +
        Object.entries(byPath)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ") +
        (slowest ? ` · slowest "${slowest.name}" ${(slowest.ms / 1000).toFixed(1)}s via ${slowest.path}` : "")
    );

    return results;
  }
}

/** POST { image, mediaType } → { jobId }, immediately.
 *
 *  The scan itself runs on after this returns. That is the point: the answer
 *  outlives the request. */
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

    const admin = createAdminClient();
    const startedAt = Date.now();
    const { data: job, error: jobErr } = await admin
      .from("scan_jobs")
      .insert({ user_id: user.id, status: "running" })
      .select("id")
      .single();
    if (jobErr || !job) {
      return NextResponse.json(
        {
          error: /scan_jobs/.test(jobErr?.message ?? "")
            ? "Scanning needs a one-time database update — run supabase/migrations/034_scan_jobs.sql."
            : "Couldn't start the scan.",
        },
        { status: 500 }
      );
    }
    const jobId = job.id as string;

    // Filled in as the scan runs, so the finished job carries its own
    // breakdown rather than one number nobody can act on.
    const timings: ScanTimings = { modelMs: 0, matchMs: 0, totalMs: 0, cards: [] };

    // Not awaited. The handler returns now; the work continues in this
    // process and reports itself into the job row.
    void runScan({ supabase, admin, userId: user.id, image, mediaType, jobId, timings })
      .then(async (results) => {
        const patch = {
          status: "done",
          cards: results,
          expected: results.length,
          duration_ms: Date.now() - startedAt,
          timings,
          updated_at: new Date().toISOString(),
        };
        const { error } = await admin.from("scan_jobs").update(patch).eq("id", jobId);
        // timings only exists after migration 053. A scan must not fail to
        // record itself over a diagnostic column.
        if (error && /timings/.test(error.message)) {
          const { timings: _drop, ...rest } = patch;
          await admin.from("scan_jobs").update(rest).eq("id", jobId);
        }
      })
      .catch(async (err) => {
        // Recorded on the job, not thrown into a void. The person is owed an
        // explanation on a scan they have already been charged for.
        await admin
          .from("scan_jobs")
          .update({
            status: "error",
            error: safeMessage(err, "Scan failed"),
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      });

    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("scan error", err);
    return errorJson(err, "Scan failed");
  }
}

/** GET ?job=<id> — where a scan got to. Also GET with no id: the most recent
 *  unfinished scan, which is how a phone that slept finds its way back. */
export async function GET(req: Request) {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const id = new URL(req.url).searchParams.get("job");

    let q = supabase
      .from("scan_jobs")
      .select("id, status, expected, cards, error, duration_ms, created_at")
      .eq("user_id", user.id);
    q = id ? q.eq("id", id) : q.eq("status", "running");

    const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) return NextResponse.json({ job: null, migrated: false });
    return NextResponse.json({ job: data ?? null, migrated: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ job: null }, { status: 500 });
  }
}
