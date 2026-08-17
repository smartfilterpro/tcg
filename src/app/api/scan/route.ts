import { NextResponse } from "next/server";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { matchDetectedCard, numberKey, strictNumberKey, cleanCardName } from "@/lib/pokemontcg";
import { normalizeForSearch } from "@/lib/text";
import { searchTcgdex } from "@/lib/tcgdex";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage } from "@/lib/usage";
import { checkCredits } from "@/lib/credits";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createObjectScanner, isEnvelope } from "@/lib/jsonStream";
import {
  rowToSummary,
  summaryToRow,
  defaultVariantFor,
  isSpecificPrinting,
  CARD_SUMMARY_COLUMNS,
  type CardSummaryRow,
} from "@/lib/types";
import { gapFill, CARD_COMPANIONS } from "@/lib/cardWrite";
import { pickPrinting, patternPrintingFor } from "@/lib/cardPrinting";
import { setsAgree } from "@/lib/setName";
import type { CardSummary, DetectedCard, ScanMatch } from "@/lib/types";
import { loadFinishOverrides } from "@/lib/finishFeedback";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorJson, PublicError, safeMessage } from "@/lib/apiError";
import { readJson, SCAN_BODY_LIMIT } from "@/lib/requestBody";

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
  if (!detected.name) return null;
  const wanted = normalizeForSearch(detected.name);
  if (!wanted) return null;

  let rows: CardSummaryRow[];
  try {
    // The indexed, spelling-blind key from migration 066: accents, case,
    // apostrophes and hyphens all folded away, so a detected "Flabebe" or
    // "Team Rockets Mewtwo ex" (apostrophe unreadable on a glossy card)
    // still answers. A PREFIX match on purpose — printings the paid sync
    // names the TCGplayer way, "Dragonair (Poké Ball Pattern)", must be in
    // the candidate set when the photo says "Dragonair". Ordered so exact
    // names and their printings sort ahead of longer names sharing the
    // prefix ("Mew" before "Mewtwo"), which makes the limit safe.
    const { data, error } = await supabase
      .from("cards")
      .select(CARD_SUMMARY_COLUMNS)
      .like("name_key", `${wanted}%`)
      .order("name_key")
      .order("id")
      .limit(100);
    if (error) throw error;
    rows = (data ?? []) as unknown as CardSummaryRow[];
  } catch (errKeyed) {
    // No name_key column until migration 066 runs — fall back to the old
    // byte-exact shape rather than sending every card to an external API.
    try {
      const { data, error } = await supabase
        .from("cards")
        .select(CARD_SUMMARY_COLUMNS)
        .ilike("name", detected.name.replace(/[%_]/g, ""))
        .order("id")
        .limit(60);
      if (error) throw error;
      rows = (data ?? []) as unknown as CardSummaryRow[];
    } catch (errPlain) {
      // A failed query is NOT "we don't have this card" — it used to be
      // swallowed silently and logged as an external-path miss, hiding
      // database trouble inside matching telemetry. Same remedy (external
      // lookup), but say what actually happened.
      console.warn(
        `scan: local match query failed for "${detected.name}"`,
        errPlain ?? errKeyed
      );
      return null;
    }
  }

  try {
    // Keep only rows that ARE this name: identical under normalization, or
    // a named printing of it (parenthetical suffix). The prefix query alone
    // would let "Mewtwo" answer for "Mew".
    const all = rows.filter((r) => {
      const n = normalizeForSearch(r.name);
      return n === wanted || (n.startsWith(wanted) && isSpecificPrinting(r.name));
    });
    const key = strictNumberKey(detected.collectorNumber);
    const setHint = detected.setNameHint?.trim() || null;

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
      const numbers = new Set(byName.map((r) => strictNumberKey(r.number)));
      if (numbers.size !== 1) return null;
      const picked = pickPrinting(byName, detected.rarityHint);
      return picked ? rowToSummary(picked) : null;
    }

    // Strict key: letters on a collector number are identity, not noise. The
    // loose digits-only key here matched a promo read as "SWSH095" against
    // the #95 of an unrelated set and called it a confident local hit.
    let hits = all.filter((r) => strictNumberKey(r.number) === key);
    // The set, when the scanner read one, gets a say — this path used to
    // ignore it entirely, which is how reprints sharing a collector number
    // (a Trick or Trade Haunter keeps the original's number) could come back
    // as the wrong set's card. Narrowing only: an unrecognisable set hint
    // refutes nothing.
    if (setHint) {
      const bySet = hits.filter((r) => setsAgree(r.set_name, setHint));
      if (bySet.length > 0) hits = bySet;
    }
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
  } catch (err) {
    console.warn(`scan: local match failed for "${detected.name}"`, err);
    return null; // any local hiccup → just use the external APIs
  }
}

/** Remember a card the catalogue couldn't answer, so it can next time.
 *
 *  The scan never wrote its external matches anywhere — only SAVING a card
 *  did. A card scanned and then skipped, dismissed, or lost to a closed tab
 *  paid the full external round trip again on every future scan, by every
 *  member. One write ends that: the next scan of this card is a local hit.
 *
 *  Guarded against manufacturing the duplicate-printing miss it exists to
 *  prevent: if the catalogue already holds this card under ANOTHER id scheme
 *  (same normalized name, same strict number, agreeing set), nothing is
 *  written — the local matcher's job is to find that row, not this code's
 *  job to shadow it. Writes go through gapFill so a thin external record can
 *  never blank a price or image a richer source already stored. */
async function stashExternalMatch(admin: SupabaseClient, card: CardSummary): Promise<void> {
  const wanted = normalizeForSearch(card.name);
  const strict = strictNumberKey(card.number);
  if (!wanted || !card.id || !card.setId || !card.setName) return;

  let rows: Array<{ id: string; number: string; set_name: string | null }>;
  try {
    const { data, error } = await admin
      .from("cards")
      .select("id, number, set_name")
      .like("name_key", `${wanted}%`)
      .limit(60);
    if (error) throw error;
    rows = (data ?? []) as typeof rows;
  } catch {
    // Pre-066 fallback: byte-exact name. Weaker guard, same idea.
    const { data } = await admin
      .from("cards")
      .select("id, number, set_name")
      .ilike("name", card.name.replace(/[%_]/g, ""))
      .limit(60);
    rows = (data ?? []) as typeof rows;
  }
  const alreadyHeld = rows.some(
    (r) =>
      r.id === card.id ||
      (strictNumberKey(r.number) === strict && setsAgree(r.set_name, card.setName))
  );
  if (alreadyHeld) return;

  const row = gapFill(summaryToRow(card) as unknown as Record<string, unknown>, {
    companions: CARD_COMPANIONS,
  });
  const { error } = await admin
    .from("cards")
    .upsert([row], { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

/** How long one card may spend on external lookups before the scan moves on.
 *
 *  A person is watching a spinner, and an unmatched card costs them one tap
 *  to fix. Twelve seconds is generous for two attempts at two query shapes
 *  and firmly bounded: seven cards can no longer add up to a minute because
 *  one of them was unlucky. */
const EXTERNAL_BUDGET_MS = 12_000;

/** How many cards may be looked up at once.
 *
 *  Unchanged from the old batch size — the point of the pool is not to hit
 *  other people's servers harder, it is to stop fast cards waiting behind
 *  slow ones. */
const MATCH_CONCURRENCY = 4;

/** Run `fn` over `items`, at most `limit` at a time, keeping order.
 *
 *  A worker takes the next index the moment it is free, so nothing waits on
 *  a neighbour. That is the whole difference from batching. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

/** Give up on a promise once the deadline passes, and carry on.
 *
 *  The work is abandoned rather than cancelled — the request will finish
 *  somewhere and its answer thrown away. That is the honest cost of a
 *  fetch with no abort signal threaded through it, and it is much cheaper
 *  than the alternative, which is a whole scan waiting on one card. */
async function withinDeadline<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), left);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      // Reading a card face is perception, not reasoning. Left unset, this
      // model THINKS before answering — a silent 1.5–5s of deliberation per
      // scan that showed up in modelMs and helped nothing: the names and
      // numbers come off the image, not from working anything out. Turning
      // it off is the single largest scan-latency win in this file.
      thinking: { type: "disabled" },
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
    // The model is done HERE. This stamp used to sit after usage logging and
    // JSON parsing, so three serialized ledger writes (150–600ms) were billed
    // to "model time" in every scan log line — telemetry blaming the wrong
    // suspect. And nothing about the ledger needs to hold up matching: let it
    // land whenever it lands, and let a failure be its own quiet log line
    // rather than a failed scan someone already paid the model for.
    timings.modelMs = Date.now() - scanStartedAt;

    void logAiUsage(supabase, userId, "scan", SCAN_MODEL, response.usage).catch((err) =>
      console.warn(`scan ${jobId}: usage logging failed`, err)
    );

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

    const matchStartedAt = Date.now();
    // A POOL, NOT BATCHES.
    //
    // This used to run in fixed batches of four, and a batch finishes when
    // its slowest member does — so six cards that resolved in milliseconds
    // sat waiting on one that took half a minute, twice over. A seven-card
    // scan spent 62 seconds matching against 9 seconds of model time, and
    // almost all of it was cards doing nothing.
    //
    // Same concurrency, no barrier: a worker that finishes starts the next
    // card immediately instead of waiting for its neighbours. Order is
    // preserved by index because the results line up with the photos.
    const results: ScanMatch[] = await mapPool(
      detectedCards,
      MATCH_CONCURRENCY,
      async (detected) => {
          const cardStartedAt = Date.now();
          const cardDeadline = cardStartedAt + EXTERNAL_BUDGET_MS;
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
          // The deadline goes in AND the call is raced against it. Passing
          // it inward should be enough, and twice now it hasn't been — a
          // Retry-After sleep walked through it once already. The engine of
          // record for "this card is out of time" is this line, not the
          // goodwill of whatever sits under it.
          let { match, candidates } = await withinDeadline(
            matchDetectedCard(detected, {
              deadline: cardDeadline,
              timeoutMs: 8_000,
              attempts: 2,
            }),
            cardDeadline + 1_000,
            { match: null, candidates: [] as CardSummary[] }
          );
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
            // The budget covers THIS too. It used to gate only the primary
            // matcher, so a card could spend its whole twelve seconds there
            // and then another nineteen here, unbounded — which is how one
            // card reached 31.2 seconds against a 12-second budget. A budget
            // that only covers the first half of the work is not a budget.
            const alt = await withinDeadline(
              searchTcgdex({
                name: detected.name,
                number: detected.collectorNumber ?? undefined,
                pageSize: 6,
              }),
              cardDeadline,
              [] as CardSummary[]
            );
            const altNumberMatches = key
              ? alt.filter((c) => numberKey(c.number) === key)
              : alt;
            // "A name and a number are not a card" — promo bundles reprint
            // at the original collector number, so taking the first
            // number-match blind can cross sets. Prefer a candidate whose
            // number matches with its letters intact and whose set agrees
            // with what the scanner read; stable sort keeps the original
            // order among equals.
            const strict = strictNumberKey(detected.collectorNumber);
            const altRank = (c: CardSummary) =>
              (strict && strictNumberKey(c.number) === strict ? 0 : 2) +
              (detected.setNameHint && setsAgree(c.setName, detected.setNameHint) ? 0 : 1);
            altNumberMatches.sort((a, b) => altRank(a) - altRank(b));
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
          // Off the hot path on purpose: the scan's answer doesn't wait on
          // the catalogue learning it.
          if (match) {
            const learned = match;
            void stashExternalMatch(admin, learned).catch((err) =>
              console.warn(`scan: couldn't stash "${learned.name}" (${learned.id})`, err)
            );
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
      }
    );

    // How many of each of these they already own.
    //
    // Answered here rather than by the client because we are already holding
    // the matched ids and the user's session — one query instead of a round
    // trip, and it means the results screen can say "×3 now" instead of
    // making someone remember.
    // Two independent garnishes — neither reads the other's answer, so they
    // used to cost two round trips back to back for no reason. Both are
    // best-effort: a missing count shows as "new" (never claims ownership),
    // and finish memory failing never breaks a scan.
    await Promise.all([
      (async () => {
        try {
          const ids = [...new Set(results.filter((r) => r.match).map((r) => r.match!.id))];
          if (ids.length === 0) return;
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
        } catch {
          // Best-effort — see above.
        }
      })(),
      // Apply the scanner's learned finish memory: if this exact guess on
      // this exact card has been corrected by members before, suggest the
      // corrected finish instead of repeating the mistake.
      (async () => {
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
          // Best-effort — see above.
        }
      })(),
    ]);

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
    const { image, mediaType } = await readJson<{
      image?: string;
      mediaType?: string;
    }>(req, SCAN_BODY_LIMIT);
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
