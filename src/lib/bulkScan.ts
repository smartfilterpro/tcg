// The mail-in scanning service's brain: read one card photo, match it to
// the catalogue, verify the answer, and decide who needs a human.
//
// Confidence is deliberately binary-by-agreement, not a probability the
// model reports about itself. A card is VERIFIED when two independent
// looks agree: normally the identifying read plus a second, adversarial
// examination of the same photo (confirm the card, re-judge the finish
// from scratch); or, when the feeder runs an optional second pass, two
// photographs resolving to the same catalogue card. Everything else —
// disagreement, a failed read, an unconfirmed answer — is a review row.
// Self-reported model confidence is decoration; two matching looks is
// evidence.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropic, SCAN_MODEL } from "@/lib/anthropic";
import { estimateCostUsd, logAiUsage, tokensFrom } from "@/lib/usage";
import { numberKey } from "@/lib/pokemontcg";
import { normalizeForSearch } from "@/lib/text";
import { patternPrintingFor, pickPrinting } from "@/lib/cardPrinting";
import { ballPatternOf, defaultVariantFor, isSpecificPrinting, summaryToRow } from "@/lib/types";
import { matchMtgCard } from "@/lib/scryfall";

export const BULK_BUCKET = "bulk-scans";
export const MAX_JOB_CARDS = 8000;

export interface BulkRead {
  name?: string;
  number?: string;
  set_name?: string;
  /** Which game's card the photo shows — decides which half of the
   *  catalogue the read matches against. Absent on reads made before the
   *  reader learned Magic; treated as Pokémon, which they all were. */
  game?: "pokemon" | "mtg";
  finish?: string;
  /** How the card sat in the photo (upright / upside_down / sideways) —
   *  the review screen uses it to display the scan righted. */
  orientation?: string;
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
  /** Did the second, independent look at the same photo confirm both the
   *  identification and the finish? true verifies a single-pass row on its
   *  own; false sends it to review with checkNote saying why; absent means
   *  no second look ran (an old read, or a pass-2 photo). */
  checked?: boolean;
  checkNote?: string | null;
  /** When cardId is null: WHY the catalogue match came up empty, in words a
   *  reviewer can act on. */
  matchNote?: string | null;
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
  // Not a ball, but the same kind of thing: the Mega-era pattern reverse
  // whose etched motif is repeating energy symbols, sold as its own
  // "(Energy Symbol Pattern)" product.
  energy_symbol: "Energy Symbol pattern",
};

/** Mean luminance of a card image's artwork window and body/text region,
 *  on a normalized 100×140 grayscale. The finish call kept failing as a
 *  qualitative judgment ("does the body look darker?"), so it stops being
 *  one: these are computed pixels, fed to the check as numbers. The
 *  body/artwork RATIO is the exposure-invariant signal — a reverse holo
 *  depresses the body relative to the artwork, a holo the artwork
 *  relative to the body. sharp ships with Next; a decode failure just
 *  means no numbers, never a failed read. */
async function luminanceStats(
  buf: Buffer,
  rotate180: boolean
): Promise<{ art: number; body: number } | null> {
  try {
    const sharpMod = (await import("sharp")) as unknown as { default: (b: Buffer) => unknown };
    type SharpChain = {
      rotate: (d: number) => SharpChain;
      greyscale: () => SharpChain;
      resize: (w: number, h: number, o: Record<string, unknown>) => SharpChain;
      raw: () => SharpChain;
      toBuffer: () => Promise<Buffer>;
    };
    let img = sharpMod.default(buf) as SharpChain;
    if (rotate180) img = img.rotate(180);
    const raw = await img.greyscale().resize(100, 140, { fit: "fill" }).raw().toBuffer();
    const W = 100;
    const mean = (x0: number, x1: number, y0: number, y1: number) => {
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += raw[y * W + x];
          n++;
        }
      }
      return n > 0 ? Math.round(sum / n) : 0;
    };
    // Relative card geometry: artwork ≈ upper-middle window, body/text ≈
    // the attack-text band below it. Borders excluded on all sides.
    return { art: mean(10, 90, 20, 65), body: mean(10, 90, 80, 125) };
  } catch {
    return null;
  }
}

/** The machine learning from its reviewers, without a training run.
 *
 *  Every hand-corrected row is a labeled example: the stored read says
 *  what the machine called the finish, the saved variant says what the
 *  human holding the card decided. Aggregated into a short calibration
 *  note and appended to both looks' system prompts, so the model is told
 *  its OWN recent systematic errors — "you keep under-calling reverse
 *  holo" — in numbers, from this rig's actual history. Cached ten
 *  minutes; empty (and free) until corrections exist. */
let calibCache: { at: number; text: string } = { at: 0, text: "" };
async function correctionCalibration(admin: SupabaseClient): Promise<string> {
  if (Date.now() - calibCache.at < 10 * 60 * 1000) return calibCache.text;
  try {
    const { data } = await admin
      .from("bulk_cards")
      .select("pass1_read, variant")
      .eq("confidence", "corrected")
      .not("pass1_read", "is", null)
      .order("updated_at", { ascending: false })
      .limit(400);
    const clsFinish = (f?: string | null) =>
      f === "holofoil" ? "holo" : f === "reverse_holofoil" ? "reverse holo" : f ? "normal" : null;
    const clsVariant = (v?: string | null) =>
      v === "holofoil" || v === "foil"
        ? "holo"
        : v === "reverseHolofoil" ||
            ["pokeBall", "masterBall", "friendBall", "loveBall", "energySymbol"].includes(v ?? "")
          ? "reverse holo"
          : v === "normal"
            ? "normal"
            : null;
    const flows = new Map<string, number>();
    for (const r of data ?? []) {
      const read = r.pass1_read as { finish?: string } | null;
      const from = clsFinish(read?.finish);
      const to = clsVariant(r.variant as string | null);
      if (from && to && from !== to) {
        const k = `called ${from}, human corrected to ${to}`;
        flows.set(k, (flows.get(k) ?? 0) + 1);
      }
    }
    const lines = [...flows.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${n}× ${k}`);
    calibCache = {
      at: Date.now(),
      text:
        lines.length > 0
          ? `\n\nCALIBRATION FROM HUMAN REVIEW — real corrections reviewers made to this machine's recent finish calls: ${lines.join("; ")}. These are its systematic errors on this rig's lighting; on borderline finish judgments, lean against repeating them.`
          : "",
    };
  } catch {
    calibCache = { at: Date.now(), text: "" };
  }
  return calibCache.text;
}

const READ_SCHEMA = {
  type: "object",
  properties: {
    game: {
      type: "string",
      enum: ["pokemon", "mtg"],
      description:
        "Which game printed this card. Magic: The Gathering cards have a mana " +
        "cost top-right, a type line mid-card ('Creature — ...', 'Instant', " +
        "'Basic Land — Mountain') and a set code bottom-left. Pokémon cards " +
        "have HP top-right, energy-cost attacks, and a NNN/NNN collector number.",
    },
    name: { type: "string", description: "The card's printed name, exactly as printed." },
    number: {
      type: "string",
      description:
        "Collector number as printed. Pokémon: e.g. '050/191' or 'TG12/TG30'. " +
        "Magic: bottom-left, e.g. '0170' or '123/281'. Empty if unreadable.",
    },
    set_name: {
      type: "string",
      description:
        "Set name if identifiable (for Magic, the 3-5 letter set code bottom-left " +
        "also counts), else empty.",
    },
    finish: {
      type: "string",
      enum: ["normal", "holofoil", "reverse_holofoil"],
      description:
        "Where the shine is. The machine's own lamp puts a bright band or wash on EVERY card — that is GLARE, not foil: it is white or the lamp's own colour, crosses artwork, border and text alike, and has no repeating motif. 'holofoil': the ARTWORK window shows rainbow/prismatic colour (or the whole card does, as on full arts, ex cards, and foil Magic cards). 'reverse_holofoil': Pokémon only — the CARD BODY (not the artwork) carries etched foil with a visible REPEATING pattern and rainbow colour shift; the artwork window stays matte. 'normal': no foil — including when the only shine is the lamp's band or wash. Answer a foil value only on positive evidence: rainbow colour that varies across the surface, or a visible etched pattern. Brightness alone is 'normal'. EXCEPTION for flat document-scanner images (even light, no glare band): the rainbow is muted there and foil scans DARK instead — artwork darker than body = holofoil (the shimmer typically fills the artwork right to its edges); body/text darker than artwork = reverse_holofoil — a reverse's TEXT AREAS scan dark, and on a dark card even the printed NAME can be hard to read, which is itself reverse evidence; uniformly light = normal.",
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
        "energy_symbol",
        "none",
        "unknown",
      ],
      description:
        "The motif etched or watermarked into the CARD BODY, repeating across it. Report a motif you can SEE regardless of what you answered for finish — on scanner images the motif shows as a pale repeating watermark, and seeing one MEANS the card is a pattern reverse holo even if it read as matte. A ball motif ('poke_ball' / 'master_ball' / 'friend_ball' / 'love_ball', or 'other_ball' for one you can see but can't name) marks a separate, much rarer printing and must not be missed; 'energy_symbol' is the same idea with repeating ENERGY TYPE SYMBOLS (grass leaves, flames, water drops…) as the motif. 'standard' is the set's ORDINARY reverse pattern — stars, set symbols, sparkle, or ONE LARGE Poké Ball watermark filling the body (the modern sets' normal reverse: a single big ball is 'standard'; only SMALL REPEATING balls are a ball pattern). 'none' when no motif is visible — PLENTY of reverse holos carry no motif at all, so a missing motif is never evidence against reverse holo. 'unknown' when foil is present but the pattern can't be made out — never guess a ball.",
    },
    stamp: {
      type: "string",
      enum: ["none", "pokemon_center", "prerelease", "staff", "unknown"],
      description:
        "Gold foil stamp pressed ONTO THE ARTWORK ITSELF: a Pokémon Center logo, the word PRERELEASE, or the word STAFF — a large gold badge sitting on top of the illustration. NOT a stamp: the set code in the bottom-left info bar. In particular the code PRE (Prismatic Evolutions) is a SET CODE that appears on every card of that set — reading it as a prerelease stamp is the known mistake here. 'none' when there is clearly none.",
    },
    readable: {
      type: "boolean",
      description: "False if the photo shows no readable card (blank, sleeve, misfeed).",
    },
    language: {
      type: "string",
      enum: ["en", "ja", "other"],
      description:
        "The card's printed language. Japanese cards use Japanese script for the name and attacks; their set numbering differs from English printings.",
    },
    name_english: {
      type: "string",
      description:
        "ONLY when language is not 'en': the card's ENGLISH name (e.g. バルジーナ → Mandibuzz). Empty for English cards.",
    },
    orientation: {
      type: "string",
      enum: ["upright", "upside_down", "sideways", "unknown"],
      description:
        "How the card sits in the photo. A feeder takes cards any way up — an upside-down card is still THIS card: mentally rotate and read it exactly as carefully, then report the orientation here so the review screen can right it.",
    },
  },
  required: ["game", "name", "number", "set_name", "finish", "pattern", "stamp", "readable", "orientation", "language", "name_english"],
  // The structured-output API refuses object schemas without this — every
  // bulk read was 400ing ("'additionalProperties' must be explicitly set
  // to false"), and unlike the aiJson surfaces this path has no
  // schema-less retry, so the whole pipeline read nothing.
  additionalProperties: false,
} as const;

const READ_SYSTEM = `You read a single trading card — Pokémon TCG or Magic:
The Gathering — from one photograph taken by a card-feeding machine. The
card fills most of the frame and may be slightly rotated. First decide which
game printed it, then report exactly what is printed — name, collector
number, set if identifiable, finish, and (Pokémon only) reverse-holo pattern
and any gold stamp; for a Magic card answer pattern='none' and stamp='none'.
A card from EITHER game is readable; set readable=false ONLY when the photo
shows no card face at all (blank frame, card back, misfeed).

The card fills the frame, so you can see detail a phone snapshot of a whole
binder page cannot. Use it. The reverse-holo PATTERN is the field most worth
your attention: a Poké Ball, Master Ball, Friend Ball or Love Ball motif
repeating across the foil marks a different and far more valuable printing
than the same card with the set's ordinary star pattern, and the whole point
of this machine is that nobody has to check its work afterwards. Look at the
foil area specifically, not the artwork. If you genuinely cannot tell, say
'unknown' — that is a useful answer and a wrong ball is not.

One warning about the machine itself: its lamp sits close to the card, so
EVERY photo has some shine. A bright band or an overall wash that crosses
artwork and border alike, in white or the lamp's colour, is LIGHTING. Foil
announces itself differently — rainbow colours that change across the
surface, or an etched repeating motif in the card body. When the only
evidence is brightness, the finish is 'normal'.

Some photos come from a DOCUMENT SCANNER instead of a camera: flat, even
light, no glare band — and the rainbow shift is MUTED, so foil announces
itself by DARKNESS instead. Foil regions scan noticeably darker and
duller than paper. Read the darkness map: artwork window darker than the
body → 'holofoil'; body and text areas darker than the artwork →
'reverse_holofoil' (the etched motif is usually still visible in that
dark body); the whole card uniformly light → 'normal'.`;

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    same_card: {
      type: "boolean",
      description:
        "False ONLY when something legible in the photo CONTRADICTS the " +
        "identification — a different name, a different collector number, a " +
        "visibly different card. A detail you cannot make out (an illegible " +
        "set name, a blurry symbol) is NOT a contradiction, and neither is a " +
        "set code or set name that doesn't match your MEMORY of it — the " +
        "catalogue knows sets you don't. The identification came from a " +
        "catalogue match on what IS legible; doubt about the rest belongs in " +
        "'concern', with same_card still true.",
    },
    finish: {
      type: "string",
      enum: ["normal", "holofoil", "reverse_holofoil"],
      description:
        "Your OWN finish call, examined from scratch. The single most common mistake " +
        "you are checking for: the rig's lamp puts a bright band or wash on EVERY " +
        "card, and the first look calls that a reverse holo. A uniform sheen that " +
        "crosses artwork, border and text alike, with no repeating motif and no " +
        "rainbow colour shift, is GLARE — answer 'normal'. 'holofoil': rainbow/" +
        "prismatic colour in the artwork window (or the whole card, on full arts, ex " +
        "cards, and foil Magic cards). 'reverse_holofoil': Pokémon only — an etched " +
        "REPEATING pattern with rainbow shift in the card body, matte artwork. " +
        "Foil needs positive evidence; brightness alone is 'normal'. On a flat " +
        "document-scanner image (even light, no glare band) the rainbow is muted " +
        "and DARKNESS is the tell instead: artwork darker than body = holo; body/" +
        "text darker than artwork = reverse holo; uniformly light = normal.",
    },
    pattern: {
      type: "string",
      enum: ["standard", "poke_ball", "master_ball", "friend_ball", "love_ball", "other_ball", "energy_symbol", "none", "unknown"],
      description:
        "The motif etched or watermarked into the card body, if you can SEE one " +
        "(a ball, or 'energy_symbol' for repeating energy type symbols) — report " +
        "it regardless of the finish answer; a visible motif means a reverse " +
        "holo — but ONE large Poké Ball filling the body is 'standard' (the " +
        "modern normal reverse); only SMALL REPEATING balls are a ball pattern. " +
        "'none' when no motif is visible — many reverse holos have no motif, " +
        "so 'none' never argues against a reverse finish (always 'none' for Magic).",
    },
    stamp: {
      type: "string",
      enum: ["none", "pokemon_center", "prerelease", "staff", "unknown"],
      description:
        "Gold foil stamp ON THE ARTWORK itself, or 'none'. The set code in the " +
        "bottom-left bar is never a stamp — PRE there means the set Prismatic " +
        "Evolutions, not PRERELEASE.",
    },
    concern: {
      type: "string",
      description:
        "Empty when confident. Otherwise ONE short sentence: exactly what made you " +
        "unsure or disagree.",
    },
  },
  required: ["same_card", "finish", "pattern", "stamp", "concern"],
  additionalProperties: false,
} as const;

const CHECK_SYSTEM = `You are the second set of eyes on a card-scanning
machine. A first read identified the photographed card; your job is to
catch its mistakes before the card is filed with no human ever checking.
Judge INDEPENDENTLY from the photograph: does it truly show the named
printing, and — examined from scratch, foil area specifically — what is
the finish, the reverse-holo pattern, and any gold stamp? On finish,
be especially sceptical of the first look: the rig's lamp shines on
every card, and a bright band is not foil — reverse holo needs a
visible etched repeating pattern, holo needs rainbow colour, and shine
that is merely bright means 'normal'. On a flat document-scanner image
(even light, no glare) judge by DARKNESS instead: foil scans dark, so a
dark artwork window means holo, a dark body around light artwork means
reverse holo, and a uniformly light card is normal.

Disagreeing when you SEE a real discrepancy is exactly what you are for:
a name or number that reads differently, a finish the first look got
wrong. But doubt is not disagreement. You are not asked to re-prove the
identification from nothing — a set name you cannot make out, a symbol
too blurry to name, a card photographed upside down are not evidence
against it. And rejections must come from the cardboard, not from
memory: never overrule a match with recalled trivia about set codes,
set names, or what a set "should" contain. Sets newer than your
knowledge exist and the catalogue is the authority on them — a set code
you don't recognize, or remember differently, means nothing. A
different printed NAME or a different printed NUMBER is a real
contradiction. Reject what contradicts the photo; confirm what nothing
contradicts; put what you merely couldn't verify in 'concern'.`;

/** Read one photo and resolve it against the catalogue. Charges the JOB,
 *  never a member: usage is logged under the admin who created the job with
 *  the bulk_scan endpoint tag, and the dollar cost is added to the job row
 *  for the service's own billing.
 *
 *  With opts.check, a matched read gets a SECOND, independent look at the
 *  same photo — confirm the identification, re-examine the finish from
 *  scratch. Agreement between two looks at one clear photo replaces the
 *  old second feeding pass; disagreement goes to review with the reason. */
export async function identifyPhoto(
  admin: SupabaseClient,
  jobId: string,
  adminUserId: string,
  image: { data: string; mediaType: string },
  opts?: { check?: boolean }
): Promise<BulkRead> {
  try {
    const client = anthropic();
    const calibration = await correctionCalibration(admin);
    const res = await client.messages.create({
      model: SCAN_MODEL,
      max_tokens: 400,
      // Perception, not reasoning — same as the phone scanner. Left unset the
      // model deliberates before answering, which adds seconds per photo and
      // reads nothing extra off the cardboard.
      thinking: { type: "disabled" },
      system: READ_SYSTEM + calibration,
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

    // Bookkeeping rides behind the answer, not in front of it: three ledger
    // round trips were serialized between the model finishing and the match
    // starting, on every single photo of an 8,000-card job. Concurrent
    // writers can race the cost increment; the read-modify-write may lose a
    // cent on a race, which is noise next to the premium — correctness
    // lives in ai_usage's rows.
    const logUsage = (usage: typeof res.usage) => {
      void (async () => {
        await logAiUsage(admin, adminUserId, "bulk_scan", SCAN_MODEL, usage);
        const cost = estimateCostUsd(SCAN_MODEL, tokensFrom(usage));
        const { data: job } = await admin.from("bulk_jobs").select("ai_cost_usd").eq("id", jobId).maybeSingle();
        await admin
          .from("bulk_jobs")
          .update({ ai_cost_usd: Number(job?.ai_cost_usd ?? 0) + cost, updated_at: new Date().toISOString() })
          .eq("id", jobId);
      })().catch((err) => console.warn(`bulk job ${jobId}: usage logging failed`, err));
    };
    logUsage(res.usage);

    const block = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(block && block.type === "text" ? block.text : "{}") as {
      game?: string;
      name?: string;
      number?: string;
      set_name?: string;
      finish?: string;
      pattern?: string;
      stamp?: string;
      readable?: boolean;
      orientation?: string;
      language?: string;
      name_english?: string;
    };
    if (parsed.readable === false) {
      return { error: "no readable card in the photo (misfeed?)" };
    }
    // Self-consistency the schema also states: a visible pattern motif IS
    // reverse-holo evidence. Scanner light mutes the foil, so the model
    // sometimes reports the watermark while calling the finish matte —
    // the motif wins.
    if (BALL_WORDS[parsed.pattern ?? ""] && parsed.finish !== "reverse_holofoil") {
      parsed.finish = "reverse_holofoil";
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
      game: parsed.game === "mtg" ? "mtg" : "pokemon",
      finish: parsed.finish ?? "normal",
      orientation: parsed.orientation,
      hint,
    };
    // A non-English card can't match the catalogue as printed — it holds
    // ENGLISH printings (for now). Match on the English name instead, with
    // the number stripped: Japanese numbering never lines up with English
    // sets, so keeping it would filter to unrelated #48s. The art is the
    // same across languages, which is exactly what the photo arbitration
    // judges by — and the row is always human-gated below.
    const foreign = !!parsed.language && parsed.language !== "en";
    const englishName = (parsed.name_english ?? "").trim();
    const matchRead: BulkRead =
      foreign && englishName ? { ...read, name: englishName, number: "", set_name: "" } : read;
    const { candidates, ...matchResult } = await matchCatalogue(admin, matchRead, hint);
    let matched: BulkRead = { ...read, ...matchResult };

    // The catalogue only holds what this app has seen; Scryfall holds all
    // of Magic. A Magic read that matches nothing locally asks Scryfall by
    // name and number — free and keyless, the same road the picker's
    // search takes — and the row is stashed so the next copy is local.
    // (Pokémon stays local-first: its catalogue is synced wholesale.)
    if (!matched.cardId && read.game === "mtg" && (read.name ?? "").trim()) {
      try {
        const { match } = await matchMtgCard({
          game: "mtg",
          name: (read.name ?? "").trim(),
          collectorNumber: (read.number ?? "").split("/")[0].trim() || null,
          setTotal: null,
          setNameHint: (read.set_name ?? "").trim() || null,
          rarityHint: null,
          confidence: "high",
        });
        if (match) {
          try {
            await admin
              .from("cards")
              .upsert([summaryToRow(match)], { onConflict: "id", ignoreDuplicates: true });
          } catch {
            // The stash is a bonus; the match itself still answers.
          }
          matched = {
            ...matched,
            cardId: match.id,
            cardName: match.name,
            cardNumber: match.number,
            cardSet: match.setName,
            variant: /holo/i.test(hint) ? "foil" : "normal",
            matchNote: null,
          };
        }
      } catch {
        // Scryfall down — the local verdict (and its note) stands.
      }
    }
    if (!opts?.check) return matched;

    // Arbitration: the deterministic matcher refused but had a shortlist.
    // Rules can't tell two sets apart from a name and a number — eyes can.
    // The schema's enum is the candidate ids, so the model can only pick a
    // row we actually hold, or "none"; its pick still faces the second
    // look below before anything verifies.
    if (!matched.cardId && candidates && candidates.length > 0) {
      try {
        const arb = await client.messages.create({
          model: SCAN_MODEL,
          max_tokens: 200,
          thinking: { type: "disabled" },
          system:
            "You match a photographed trading card to a catalogue. The automatic " +
            "matcher narrowed it to the candidates listed but could not choose. " +
            "Look closely at the photo — the collector number line, set symbol, " +
            "artwork, rarity mark — and answer with the id of the candidate that " +
            "IS this exact printing. Judge only from what is printed in the photo " +
            "and the candidate list, never from memory of set codes or sets — the " +
            "catalogue knows sets you don't. Answer \"none\" unless one clearly is.",
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: {
                  card_id: {
                    type: "string",
                    enum: [...candidates.map((c) => c.id), "none"],
                    description: "The candidate that is the photographed card, or \"none\".",
                  },
                },
                required: ["card_id"],
                additionalProperties: false,
              },
            },
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
                {
                  type: "text",
                  text:
                    `The read saw: ${read.name} #${read.number || "?"}` +
                    `${read.set_name ? ` (${read.set_name})` : ""}.\nCandidates:\n` +
                    candidates
                      .map(
                        (c) =>
                          `${c.id} — ${c.name} #${c.number}` +
                          `${c.set_printed_total ? `/${c.set_printed_total}` : ""}` +
                          `${c.set_name ? ` · ${c.set_name}` : ""}${c.rarity ? ` · ${c.rarity}` : ""}`
                      )
                      .join("\n"),
                },
              ],
            },
          ],
        });
        logUsage(arb.usage);
        const ablock = arb.content.find((b) => b.type === "text");
        const answer = JSON.parse(ablock && ablock.type === "text" ? ablock.text : "{}") as {
          card_id?: string;
        };
        const pick = candidates.find((c) => c.id === answer.card_id);
        if (pick) {
          matched = {
            ...matched,
            cardId: pick.id,
            cardName: pick.name,
            cardNumber: pick.number,
            cardSet: pick.set_name,
            variant: variantFor(read.game === "mtg", pick, hint),
            matchNote: null,
          };
        }
      } catch {
        // Arbitration is a bonus try; its failure keeps the honest "none".
      }
    }
    if (foreign) {
      const lang = parsed.language === "ja" ? "Japanese" : "non-English";
      return {
        ...matched,
        checked: false,
        checkNote: matched.cardId
          ? `a ${lang}-language printing — the pick is its ENGLISH equivalent (set, number and value differ between languages); confirm or delete`
          : `a ${lang}-language printing${englishName ? ` (English name: ${englishName})` : ""} — the catalogue holds English cards only for now`,
      };
    }
    if (!matched.cardId) return matched;

    // The second look. Same photo, fresh eyes, and the first answer on the
    // table to be confirmed or torn up. A check failure must not cost the
    // match we already have — it downgrades to "review", never to "error".
    //
    // With a REFERENCE alongside: the catalogue's stock render of the
    // claimed card, which is almost always its plain printing. Finish
    // stops being an absolute judgment ("does this look foil?") and
    // becomes a comparison ("is the scanned body darker than THIS body?")
    // — which is the call scanner lighting actually supports, and the one
    // prompt-tuning alone kept missing.
    const reference = await (async (): Promise<{ data: string; mediaType: string } | null> => {
      try {
        const { data: cardRow } = await admin
          .from("cards")
          .select("image_small")
          .eq("id", matched.cardId!)
          .maybeSingle();
        const url = (cardRow?.image_small as string | null) ?? null;
        if (!url || !/^https?:\/\//.test(url)) return null;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 2_000_000) return null;
        return { data: buf.toString("base64"), mediaType: type };
      } catch {
        return null; // the check runs photo-only, as it always did
      }
    })();
    // Pixel measurement alongside the reference: the numbers the check is
    // told to trust over its own impression of "darker".
    let lumText = "";
    if (reference) {
      try {
        const scanStats = await luminanceStats(
          Buffer.from(image.data, "base64"),
          parsed.orientation === "upside_down"
        );
        const refStats = await luminanceStats(Buffer.from(reference.data, "base64"), false);
        if (scanStats && refStats && scanStats.art > 5 && refStats.art > 5) {
          const scanRatio = scanStats.body / scanStats.art;
          const refRatio = refStats.body / refStats.art;
          lumText =
            `\n\nMEASURED LUMINANCE (computed from the pixels — trust these numbers over your visual impression; ignore them only if the scan shows background beyond the card):` +
            ` scan artwork ${scanStats.art}, scan body/text ${scanStats.body};` +
            ` reference artwork ${refStats.art}, reference body ${refStats.body}.` +
            ` Body÷artwork ratio: scan ${scanRatio.toFixed(2)} vs reference ${refRatio.toFixed(2)}.` +
            ` A scan ratio clearly below the reference's (≤0.85×) means the BODY is disproportionately dark → reverse holo.` +
            ` A disproportionately dark ARTWORK instead (scan artwork much darker relative to its body than the reference's) → holo.` +
            ` Ratios in line with the reference → the finish matches the reference card.`;
        }
      } catch {
        // No numbers is fine; the visual comparison still runs.
      }
    }
    try {
      const check = await client.messages.create({
        model: SCAN_MODEL,
        max_tokens: 300,
        thinking: { type: "disabled" },
        system: CHECK_SYSTEM + calibration,
        output_config: {
          format: { type: "json_schema", schema: CHECK_SCHEMA as unknown as Record<string, unknown> },
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
              ...(reference
                ? [
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: reference.mediaType as "image/jpeg" | "image/png" | "image/webp",
                        data: reference.data,
                      },
                    },
                  ]
                : []),
              {
                type: "text",
                // The set name stays OUT of this message on purpose. The set
                // was pinned deterministically (number + printed set size);
                // the name is the one field the checker can only "verify"
                // against remembered trivia, and remembered trivia about
                // sets newer than its training is where the false
                // rejections came from ("that code means a different set",
                // "a Digimon-style name"). Name, number, finish — things
                // the photo can actually answer.
                text:
                  `The FIRST image is the scanned photo. ` +
                  (reference
                    ? `The SECOND image is the catalogue's stock render of the claimed card — almost always its PLAIN (non-foil) printing, so use it two ways: confirm the artwork, name and number match, and judge the FINISH BY COMPARISON — if the scan's card body (borders, text areas) is clearly darker or foil-sheened compared to the render's body, the scan is a reverse holo; if the scan's ARTWORK window is markedly darker or colour-shifted versus the render's, it is a holo; if the scan looks like the render overall, it is normal.\n\n`
                    : "\n") +
                  `The first read filed this card as:\n` +
                  `${matched.cardName} — collector number ${matched.cardNumber}\n` +
                  `finish: ${parsed.finish ?? "normal"}, pattern: ${parsed.pattern ?? "none"}, ` +
                  `stamp: ${parsed.stamp ?? "none"}\n\nCheck it against the photo.` +
                  lumText,
              },
            ],
          },
        ],
      });
      logUsage(check.usage);
      const cblock = check.content.find((b) => b.type === "text");
      const verdict = JSON.parse(cblock && cblock.type === "text" ? cblock.text : "{}") as {
        same_card?: boolean;
        finish?: string;
        pattern?: string;
        stamp?: string;
        concern?: string;
      };
      const finishWord = (f?: string) =>
        f === "holofoil" ? "holo" : f === "reverse_holofoil" ? "reverse holo" : "no foil";
      const disagreements: string[] = [];
      if (verdict.same_card === false) disagreements.push("doubts it is that card");
      if ((verdict.finish ?? "normal") !== (parsed.finish ?? "normal")) {
        disagreements.push(
          `saw ${finishWord(verdict.finish)} where the first look saw ${finishWord(parsed.finish)}`
        );
      }
      if (
        (parsed.finish === "reverse_holofoil" || verdict.finish === "reverse_holofoil") &&
        (verdict.pattern ?? "none") !== (parsed.pattern ?? "none")
      ) {
        disagreements.push("the looks differ on the reverse-holo pattern");
      }
      if ((verdict.stamp ?? "none") !== (parsed.stamp ?? "none")) {
        disagreements.push("the looks differ on the stamp");
      }
      // A prerelease stamp never self-verifies, even with both looks
      // agreeing. The stamp multiplies the card's value and a gold blob
      // of glare can pass for one; that call belongs to a person, every
      // time.
      if (parsed.stamp === "prerelease" || verdict.stamp === "prerelease") {
        return {
          ...matched,
          checked: false,
          checkNote: "prerelease stamp read — a human must confirm the stamp before this files",
        };
      }
      // Finish and/or pattern disagreement, with the reference render in
      // hand: the second look literally compared the scan against the
      // plain printing, which the first look never saw — its call wins,
      // and the row verifies corrected instead of queueing a human for a
      // question the comparison already answered. Card identity or stamp
      // disputes still refuse.
      const finishDiff = (verdict.finish ?? "normal") !== (parsed.finish ?? "normal");
      const patternDiff =
        (parsed.finish === "reverse_holofoil" || verdict.finish === "reverse_holofoil") &&
        (verdict.pattern ?? "none") !== (parsed.pattern ?? "none");
      const onlyFoilContested =
        disagreements.length > 0 &&
        disagreements.length === (finishDiff ? 1 : 0) + (patternDiff ? 1 : 0);
      if (reference && verdict.same_card !== false && onlyFoilContested) {
        const f = verdict.finish ?? "normal";
        const adopted: BulkRead = {
          ...matched,
          variant:
            read.game === "mtg"
              ? f === "normal"
                ? "normal"
                : "foil"
              : f === "reverse_holofoil"
                ? (ballPatternOf(BALL_WORDS[verdict.pattern ?? ""] ?? "")?.variant ?? "reverseHolofoil")
                : f === "holofoil"
                  ? "holofoil"
                  : "normal",
          checked: true,
          checkNote: null,
        };
        // A ball/energy motif may have its own catalogue row — the named
        // printing with its own price. Swap onto it when we hold one.
        const ballWord = BALL_WORDS[verdict.pattern ?? ""];
        if (read.game !== "mtg" && ballWord && adopted.cardId && adopted.cardName) {
          try {
            const row = await patternPrintingFor(
              admin,
              {
                id: adopted.cardId,
                name: adopted.cardName,
                number: adopted.cardNumber ?? "",
                setName: adopted.cardSet ?? null,
              },
              ballWord
            );
            if (row) {
              adopted.cardId = row.id;
              adopted.cardName = row.name;
              adopted.cardNumber = row.number;
              adopted.cardSet = row.setName;
              adopted.variant = variantFor(false, row, ballWord);
            }
          } catch {
            // The base row wearing the pattern finish is still right.
          }
        }
        return adopted;
      }
      if (disagreements.length === 0) return { ...matched, checked: true, checkNote: null };
      const concern = (verdict.concern ?? "").trim();
      return {
        ...matched,
        checked: false,
        checkNote: `second look ${disagreements.join("; ")}${concern ? ` — ${concern}` : ""}`.slice(0, 300),
      };
    } catch (err) {
      return {
        ...matched,
        checked: false,
        checkNote: `second look failed: ${err instanceof Error ? err.message.slice(0, 150) : "unknown error"}`,
      };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "read failed" };
  }
}

/** A catalogue row a failed match wants a second opinion on. */
type MatchCandidate = {
  id: string;
  name: string;
  number: string;
  set_name: string | null;
  set_printed_total: number | null;
  rarity: string | null;
  prices: Record<string, number | null> | null;
};

/** Same matching discipline as the CSV loader: exactly one catalogue card
 *  or nothing — a guessed printing would sail through as "verified" if the
 *  guess happened twice. When it comes up empty it now says WHY
 *  (matchNote) and hands back the rows it couldn't choose between
 *  (candidates), so the caller can put the photo and the shortlist in
 *  front of the model instead of shrugging. */
async function matchCatalogue(
  admin: SupabaseClient,
  read: BulkRead,
  hint: string
): Promise<
  Pick<BulkRead, "cardId" | "cardName" | "cardNumber" | "cardSet" | "variant" | "matchNote"> & {
    candidates?: MatchCandidate[];
  }
> {
  const none = {
    cardId: null,
    cardName: null,
    cardNumber: null,
    cardSet: null,
    variant: undefined,
  };
  const name = (read.name ?? "").trim();
  if (!name) return { ...none, matchNote: "the read produced no card name" };
  const [printedRaw, totalRaw] = (read.number ?? "").split("/");
  const printed = (printedRaw ?? "").trim();
  // rarity and prices come along because the finish is decided here — the
  // card's own printings are what make "reverse holo" mean something.
  const { data } = await admin
    .from("cards")
    .select("id, name, number, set_name, set_printed_total, rarity, prices")
    .ilike("name", `%${name.replace(/[%_]/g, " ")}%`)
    .limit(60);
  const pool = (data ?? []) as MatchCandidate[];
  // A name as common as "Pikachu" has hundreds of rows, and a 60-row pool
  // is a lottery: the one printing the number points at may never be drawn,
  // after which every filter below runs on the wrong crowd. When the read
  // carries a number, a second, narrow query fetches the rows bearing it,
  // so those are in the pool by construction.
  if (printed) {
    const forms = [
      ...new Set([printed, printed.replace(/^0+/, "") || printed, printed.padStart(3, "0")]),
    ];
    const { data: numbered } = await admin
      .from("cards")
      .select("id, name, number, set_name, set_printed_total, rarity, prices")
      .ilike("name", `%${name.replace(/[%_]/g, " ")}%`)
      .in("number", forms)
      .limit(60);
    const have = new Set(pool.map((c) => c.id));
    for (const c of (numbered ?? []) as MatchCandidate[]) {
      if (!have.has(c.id)) pool.push(c);
    }
  }
  const wanted = normalizeForSearch(name);
  const rows = pool;
  // Only the read's own game gets a say. The catalogue holds both games in
  // one table, and an unfiltered name match let a Magic "Mountain" court
  // whatever shared the name — id prefix rather than the game column, so
  // this works mid-migration like every other discriminator.
  const isMtg = read.game === "mtg";
  const gameRows = rows.filter((c) => c.id.startsWith("scry-") === isMtg);

  // Exact name, PLUS the printings of it.
  //
  // An exact-name filter is what keeps "Charizard" from matching "Charizard
  // ex", and it also excluded every row this machine was just taught to
  // look for: "Dragonair (Poké Ball Pattern)" is not "Dragonair". So the
  // read could report a Master Ball and the matcher had no Master Ball row
  // to give it. A name that is the read plus a parenthetical is the same
  // card in a different printing, and belongs in the candidates.
  let hits = gameRows.filter((c) => {
    const n = normalizeForSearch(c.name);
    return n === wanted || (n.startsWith(wanted) && isSpecificPrinting(c.name));
  });
  const nameHits = hits;
  if (printed) {
    const key = numberKey(printed);
    const byNumber = hits.filter((c) => numberKey(c.number) === key);
    if (byNumber.length > 0) hits = byNumber;
  }
  // The denominator is a set fingerprint the read carries for free:
  // "002/086" can only come from a set that printed 86 cards. It's what
  // picks the right Kakuna when the read couldn't name the set — the same
  // name+number in another set has a different total.
  const total = parseInt((totalRaw ?? "").trim(), 10);
  if (Number.isFinite(total) && total > 0 && hits.length > 1) {
    const byTotal = hits.filter((c) => c.set_printed_total === total);
    if (byTotal.length > 0) hits = byTotal;
    else {
      // No printing carries this exact total — but a KNOWN different total
      // still rules a printing out. New sets often arrive in the catalogue
      // without their printed total, and demanding an exact match here let
      // sets the denominator had already disqualified stay in the running
      // against them.
      const unknownTotal = hits.filter((c) => c.set_printed_total == null);
      if (unknownTotal.length > 0 && unknownTotal.length < hits.length) hits = unknownTotal;
    }
  }
  if (read.set_name && hits.length > 1) {
    const set = normalizeForSearch(read.set_name);
    const bySet = hits.filter((c) => normalizeForSearch(c.set_name ?? "").includes(set));
    if (bySet.length > 0) hits = bySet;
  }
  // The number-line fingerprint, for when the NAME is the bad read.
  //
  // On a dark reverse holo the name is the least legible thing on the
  // card and the model sometimes guesses one ("Ogerpon" off a Meowstic);
  // the number line — 037/086 — is the most legible, and the printed
  // total names the set. So a name that matches nothing pivots to
  // number+total: the few cards in the catalogue wearing that exact line.
  // One survivor is the card (the second look still confirms it against
  // the photo, by the CORRECT name now); several go to the photo
  // arbitration as candidates, which is built for exactly this choice.
  if (hits.length === 0 && nameHits.length === 0 && printed && Number.isFinite(total) && total > 0) {
    const lineForms = [
      ...new Set([printed, printed.replace(/^0+/, "") || printed, printed.padStart(3, "0")]),
    ];
    const { data: byLine } = await admin
      .from("cards")
      .select("id, name, number, set_name, set_printed_total, rarity, prices")
      .in("number", lineForms)
      .eq("set_printed_total", total)
      .limit(30);
    const lineHits = ((byLine ?? []) as MatchCandidate[]).filter(
      (c) => c.id.startsWith("scry-") === isMtg
    );
    if (lineHits.length > 0) hits = lineHits;
  }
  if (hits.length === 0) {
    return nameHits.length === 0
      ? { ...none, matchNote: `nothing named "${name}" in the catalogue` }
      : {
          ...none,
          matchNote: `"${name}" is in the catalogue but not with number ${printed || "?"}`,
          candidates: nameHits.slice(0, 12),
        };
  }
  // Different collector numbers still means ambiguity and still refuses.
  const keys = new Set(hits.map((c) => numberKey(c.number)));
  if (keys.size > 1) {
    return {
      ...none,
      matchNote: `"${name}" matches several collector numbers — the set couldn't be pinned down`,
      candidates: hits.slice(0, 12),
    };
  }

  // Same name and number is no longer one card: the sync creates a row per
  // printing, so a Poké Ball reverse holo has its own. Pick the one the
  // photo shows — the named printing when the read saw that ball, the plain
  // row when it saw none. A machine nobody checks afterwards must not file a
  // Master Ball reverse as the common version. (Ball printings are a
  // Pokémon institution; Magic's one-row-per-printing means any survivor
  // of the checks above is already the card.)
  const picked = isMtg ? hits[0] : pickPrinting(hits, hint);
  if (!picked) {
    const sets = [...new Set(hits.map((c) => c.set_name ?? "?"))];
    return {
      ...none,
      matchNote:
        sets.length > 1
          ? `"${name}" #${printed || "?"} exists in ${sets.length} sets (${sets.slice(0, 3).join("; ")}${sets.length > 3 ? "; …" : ""}) — couldn't tell which`
          : `several printings of "${name}" #${printed || "?"} fit and none stood out`,
      candidates: hits.slice(0, 12),
    };
  }
  let variant = variantFor(isMtg, picked, hint);
  // Modern rarity vetoes "normal": since the Scarlet & Violet era every
  // ★ Rare exists ONLY in foil — there is no plain printing to file. The
  // reads can't save this one (the stock render already SHOWS the foil,
  // so "looks like the render" argues normal, wrongly), but the rarity
  // decides it outright. Reverse-holo reads keep their reverse.
  if (
    !isMtg &&
    variant === "normal" &&
    /^(?:tcgdex-)?(sv|me|rsv)/.test(picked.id) &&
    (picked.rarity ?? "").trim().toLowerCase() === "rare"
  ) {
    variant = "holofoil";
  }
  return {
    cardId: picked.id,
    cardName: picked.name,
    cardNumber: picked.number,
    cardSet: picked.set_name,
    // In the app's vocabulary, and aware of the card: a printing that only
    // exists as a reverse holo can't be recorded as a plain one, and a row
    // that IS the Poké Ball printing takes its own finish rather than the
    // pattern label. Magic speaks foil/normal instead.
    variant,
  };
}

/** One rule for both matchers: what finish label a picked row gets. */
function variantFor(
  isMtg: boolean,
  picked: { name?: string; rarity?: string | null; prices?: Record<string, number | null> | null },
  hint: string
): string {
  return isMtg ? (/holo/i.test(hint) ? "foil" : "normal") : defaultVariantFor(picked, hint);
}

export interface PairingResult {
  total: number;
  verified: number;
  review: number;
  pass1Count: number;
  pass2Count: number;
  /** Every pass-1 card found a pass-2 partner and no photo was left over. */
  aligned: boolean;
}

/** How strongly two reads look like the same physical card. Zero when
 *  either side is unreadable — no evidence either way, and the surrounding
 *  matches anchor the unreadable one to its position. */
function pairScore(a: BulkRead | null, b: BulkRead | null): number {
  if (!a?.cardId || !b?.cardId) return 0;
  if (a.cardId === b.cardId) return 3;
  // Same name, different printing pick — still clearly the same card in
  // the feeder; the disagreement goes to review, but it shouldn't shove
  // the alignment sideways.
  if (a.cardName && b.cardName && normalizeForSearch(a.cardName) === normalizeForSearch(b.cardName)) {
    return 2;
  }
  return -2;
}

const GAP = -1;

/** Global sequence alignment (the diff algorithm) between the two passes'
 *  reads: the best way to line up pass 2 against pass 1 allowing skips on
 *  either side. Banded — a shift bigger than the band would need dozens of
 *  consecutive misses, at which point review is the right answer anyway. */
function alignPasses(
  a: Array<BulkRead | null>,
  b: Array<BulkRead | null>
): { pairs: Array<[number, number]>; score: number } {
  const n = a.length;
  const m = b.length;
  const NEG = -1e9;
  const lo = Math.min(0, m - n) - 64;
  const hi = Math.max(0, m - n) + 64;
  const width = hi - lo + 1;
  const dp = new Float64Array((n + 1) * width).fill(NEG);
  const at = (i: number, j: number) => {
    const d = j - i;
    return j < 0 || j > m || d < lo || d > hi ? NEG : dp[i * width + (d - lo)];
  };
  const put = (i: number, j: number, v: number) => {
    dp[i * width + (j - i - lo)] = v;
  };
  put(0, 0, 0);
  for (let j = 1; j <= Math.min(m, hi); j++) put(0, j, j * GAP);
  for (let i = 1; i <= n; i++) {
    for (let d = Math.max(lo, -i); d <= hi; d++) {
      const j = i + d;
      if (j < 0 || j > m) continue;
      let best = NEG;
      const diag = at(i - 1, j - 1);
      const up = at(i - 1, j);
      const left = at(i, j - 1);
      if (j > 0 && diag > NEG / 2) best = Math.max(best, diag + pairScore(a[i - 1], b[j - 1]));
      if (up > NEG / 2) best = Math.max(best, up + GAP);
      if (j > 0 && left > NEG / 2) best = Math.max(best, left + GAP);
      put(i, j, best);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = at(i, j);
    if (i > 0 && j > 0 && here === at(i - 1, j - 1) + pairScore(a[i - 1], b[j - 1])) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && here === at(i - 1, j) + GAP) {
      i--;
    } else if (j > 0) {
      j--;
    } else {
      i--;
    }
  }
  pairs.reverse();
  return { pairs, score: at(n, m) };
}

/** Set each row's confidence — and, if a second pass was fed, pair it
 *  onto pass 1 first.
 *
 *  Single pass is the normal flow: a row verifies when its read's second
 *  look (identifyPhoto's check) confirmed the card and the finish. A
 *  second pass remains supported for rigs that want photo-vs-photo
 *  agreement instead:
 *
 *  Pairing is by CONTENT, not position. Positional pairing meant one
 *  missed card shifted every later pair by one and the whole job drowned
 *  in false disagreements — so it refused to pair at all when the counts
 *  differed, which broke the job a different way. Instead: every pass-2
 *  photo keeps its feed ordinal (parsed from its storage path), the two
 *  passes are lined up by sequence alignment in both directions (pass 2
 *  fed same-order or reversed — whichever aligns better wins, no setting
 *  to get wrong), and a missed card costs exactly one review row: the
 *  unpartnered card. Re-runnable until the job uploads; re-running
 *  re-derives the pairing from scratch, so late reads and re-shoots slot
 *  in. */
export async function finalizeJob(admin: SupabaseClient, jobId: string): Promise<PairingResult> {
  const { data } = await admin
    .from("bulk_cards")
    .select("id, seq, pass1_path, pass2_path, pass1_read, pass2_read, reviewed, confidence, card_id, variant")
    .eq("job_id", jobId)
    .order("seq");
  const rows = (data ?? []) as Array<{
    id: string;
    seq: number;
    pass1_path: string | null;
    pass2_path: string | null;
    pass1_read: BulkRead | null;
    pass2_read: BulkRead | null;
    reviewed: boolean;
    confidence: string | null;
  }>;
  const now = () => new Date().toISOString();

  let verified = 0;
  let review = 0;

  // A human's decision outlives re-finalizing — those rows, pairing
  // included, are frozen.
  const live = rows.filter((r) => !r.reviewed);
  for (const row of rows.filter((r) => r.reviewed)) {
    if (row.confidence !== "corrected") {
      await admin.from("bulk_cards").update({ confidence: "corrected" }).eq("id", row.id);
    }
  }

  // Pass-1 anchors, in feed order; and the pool of every un-frozen pass-2
  // photo with its own feed ordinal (encoded in the storage path, which
  // survives however many times finalize has already moved it around).
  const anchors = live.filter((r) => r.seq < 10000 && (r.pass1_path || r.pass1_read));
  type P2 = { ordinal: number; path: string; read: BulkRead | null };
  const poolByOrdinal = new Map<number, P2>();
  for (const r of live) {
    if (!r.pass2_path) continue;
    const m = /pass2\/0*(\d+)\./.exec(r.pass2_path);
    const ordinal = m ? parseInt(m[1], 10) : r.seq >= 10000 ? r.seq - 10000 : r.seq;
    poolByOrdinal.set(ordinal, { ordinal, path: r.pass2_path, read: r.pass2_read });
  }
  const pool = [...poolByOrdinal.values()].sort((x, y) => x.ordinal - y.ordinal);

  const pass1Count = anchors.length;
  const pass2Count = pool.length;

  // Line them up. The operator may have re-fed the stack in the same order
  // or flipped it — try both, keep the better alignment. Ties (all reads
  // identical, or nothing readable) pick same-order; with a tie the choice
  // can't change what verifies.
  const p1Reads = anchors.map((r) => r.pass1_read);
  const forward = alignPasses(p1Reads, pool.map((p) => p.read));
  const reversedPool = [...pool].reverse();
  const backward = alignPasses(p1Reads, reversedPool.map((p) => p.read));
  const useReverse = pass2Count > 0 && backward.score > forward.score;
  const chosenPool = useReverse ? reversedPool : pool;
  const chosen = useReverse ? backward : forward;

  const partnerOf = new Map<number, P2>(); // anchor index → pass-2 photo
  const taken = new Set<number>(); // ordinals that found a pass-1 card
  for (const [ai, bi] of chosen.pairs) {
    partnerOf.set(ai, chosenPool[bi]);
    taken.add(chosenPool[bi].ordinal);
  }

  // Anchors: write the (possibly new) partner and the verdict in one go.
  for (let ai = 0; ai < anchors.length; ai++) {
    const row = anchors[ai];
    const p1 = row.pass1_read;
    const partner = partnerOf.get(ai) ?? null;
    const p2 = partner?.read ?? null;
    // Two ways to earn "verified": a pass-2 photo whose read agrees, or —
    // the single-pass flow — the read's own second look confirmed both the
    // card and the finish. A partner that DISAGREES is never overridden by
    // the second look: disagreement between photos is exactly the evidence
    // review exists for.
    const pairAgree =
      p1?.cardId != null &&
      p2?.cardId != null &&
      p1.cardId === p2.cardId &&
      (p1.variant ?? p1.finish ?? "normal") === (p2.variant ?? p2.finish ?? "normal");
    const soloVerified = !partner && p1?.cardId != null && p1.checked === true;
    const agree = pairAgree || soloVerified;
    const base = {
      pass2_path: partner?.path ?? null,
      pass2_read: p2,
      updated_at: now(),
    };
    const patch = agree
      ? {
          ...base,
          confidence: "verified",
          card_id: p1!.cardId,
          variant: p1!.variant ?? p1!.finish ?? "normal",
          review_note: null,
        }
      : {
          ...base,
          confidence: "review",
          card_id: p1?.cardId ?? p2?.cardId ?? null,
          variant: p1?.variant ?? p1?.finish ?? p2?.variant ?? p2?.finish ?? "normal",
          review_note: ((): string => {
            if ((row.pass1_path && !p1) || (partner && !p2)) {
              return "a read is still running — re-run Finalize in a minute";
            }
            if (p1?.error || p2?.error) return `read failed: ${p1?.error ?? p2?.error}`;
            if (partner) {
              if (p1?.cardId == null || p2?.cardId == null) {
                return p1?.matchNote ?? p2?.matchNote ?? "no exact catalogue match";
              }
              return p1.cardId !== p2.cardId
                ? "passes disagree on the card"
                : "passes disagree on the finish";
            }
            if (p1?.cardId == null) return p1?.matchNote ?? "no exact catalogue match";
            if (p1.checked === false) return p1.checkNote ?? "the second look couldn't confirm the match";
            if (pass2Count > 0) return "no pass-2 photo pairs with this card — missed during pass 2?";
            // A read from before single-look verification existed.
            return "no second look on file — review by hand or re-scan";
          })(),
        };
    await admin.from("bulk_cards").update(patch).eq("id", row.id);
    if (agree) verified++;
    else review++;
  }

  // Leftover pass-2 photos become (or remain) their own review rows at
  // 10000+ordinal; orphan rows whose photo found a home, and anchor-less
  // shells emptied by the moves above, are cleaned up.
  const leftovers = pool.filter((p) => !taken.has(p.ordinal));
  for (const p of leftovers) {
    const { error } = await admin.from("bulk_cards").upsert(
      {
        job_id: jobId,
        seq: 10000 + p.ordinal,
        pass1_path: null,
        pass1_read: null,
        pass2_path: p.path,
        pass2_read: p.read,
        confidence: "review",
        card_id: p.read?.cardId ?? null,
        variant: p.read?.variant ?? p.read?.finish ?? "normal",
        review_note: "extra pass-2 photo — no pass-1 card to pair it with",
        updated_at: now(),
      },
      { onConflict: "job_id,seq" }
    );
    if (error) throw error;
    review++;
  }
  const keepSeqs = new Set(leftovers.map((p) => 10000 + p.ordinal));
  for (const r of live) {
    // A non-anchor row below 10000 is a shell with no pass-1 photo (its
    // pass-2 half, if any, just moved through the pool); orphan rows only
    // survive if their photo is still unmatched.
    const emptyShell = r.seq < 10000 && !r.pass1_path && !r.pass1_read;
    const staleOrphan = r.seq >= 10000 && !keepSeqs.has(r.seq);
    if (staleOrphan || emptyShell) {
      await admin.from("bulk_cards").delete().eq("id", r.id);
    }
  }

  const aligned =
    pass2Count > 0 && leftovers.length === 0 && anchors.every((_, ai) => partnerOf.has(ai));
  return {
    total: anchors.length + leftovers.length + rows.filter((r) => r.reviewed).length,
    verified,
    review,
    pass1Count,
    pass2Count,
    aligned,
  };
}
