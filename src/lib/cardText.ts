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
import { askForJson } from "@/lib/aiJson";
import { getBattleDataById, type CardBattleData } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";
import { signCardPhotos } from "@/lib/photoAccess";

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
      // NOT a maxItems constraint. The API rejects that keyword outright —
      // see lib/aiJson — and a rejected schema is a 400 before the model
      // ever sees the card. The count belongs in the description below, and
      // the caller slices what comes back.
      description: "The card's attacks, at most 4.",
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
      description: "The card's abilities, at most 2.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, text: { type: "string" } },
        required: ["name", "text"],
        additionalProperties: false,
      },
    },
    rules_text: {
      type: "array",
      items: { type: "string" },
      description:
        "Trainer/Special Energy effect text, exactly as printed. At most 4 lines.",
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

/** The picture, as bytes we have actually seen.
 *
 *  A url image source asks the MODEL'S side to fetch the picture, and it
 *  cannot always do that: the paid source's card images sit on a CDN that
 *  answers us and not necessarily anyone else, and a URL that 403s there
 *  comes back as a failed read here — indistinguishable, before this, from a
 *  card whose text is genuinely unreadable. We can fetch it, so we should:
 *  one request we already know succeeds, and the model gets the pixels
 *  instead of a hostname.
 *
 *  Null when the fetch fails or the file is implausible, and then the caller
 *  falls back to the URL form — worth trying, since the failure might be on
 *  our side of the wire. */
async function imageBytes(
  url: string,
  report?: (reason: string) => void
): Promise<{ media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`card read: couldn't fetch ${url} — HTTP ${res.status}`);
      report?.(`the picture wouldn't download (HTTP ${res.status})`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // 5MB is the API's limit; a card scan is a few hundred KB, so anything
    // near it is not the picture we think it is.
    if (buf.length === 0 || buf.length > 5_000_000) {
      console.warn(`card read: ${url} is ${buf.length} bytes — not sending it`);
      report?.(`the picture is ${buf.length} bytes, which isn't a usable image`);
      return null;
    }
    const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    // Sniffed rather than trusted: a CDN serving "application/octet-stream"
    // for a perfectly good PNG would otherwise be refused by the API.
    const media_type =
      buf[0] === 0x89 && buf[1] === 0x50
        ? "image/png"
        : buf[0] === 0xff && buf[1] === 0xd8
          ? "image/jpeg"
          : buf.slice(0, 4).toString("ascii") === "RIFF"
            ? "image/webp"
            : buf.slice(0, 3).toString("ascii") === "GIF"
              ? "image/gif"
              : declared === "image/png" ||
                  declared === "image/jpeg" ||
                  declared === "image/gif" ||
                  declared === "image/webp"
                ? (declared as "image/png")
                : null;
    if (!media_type) {
      console.warn(`card read: ${url} isn't an image we can send (content-type "${declared}")`);
      report?.(`the picture came back as "${declared || "an unknown type"}", not an image`);
      return null;
    }
    return { media_type, data: buf.toString("base64") };
  } catch (err) {
    console.warn(`card read: fetching ${url} failed — ${err instanceof Error ? err.message : err}`);
    report?.(`the picture couldn't be downloaded (${err instanceof Error ? err.message : "failed"})`);
    return null;
  }
}

/** Why a read produced nothing, in words a person can act on.
 *
 *  Passed in by callers that have somewhere to show it. Three straight
 *  guesses at why one Haunter wouldn't read — the CDN, the cool-off, the
 *  model — were three guesses too many: the program knew the answer every
 *  time and had nowhere to put it. */
export type ReadReport = (reason: string) => void;

export async function readCardFromImage(
  imageUrl: string,
  userId: string | null,
  admin: SupabaseClient,
  report?: ReadReport,
  /** A second URL for the same card, tried only if the first won't
   *  download. A card carries a large and a small image and they can come
   *  from different places — one mirrored into our own storage, one still
   *  pointing at a source that has since started refusing us — so failing on
   *  the first when the second would have worked is a read thrown away for
   *  no reason. Only the download is retried; the model is still asked once. */
  altUrl?: string | null
): Promise<CardBattleData | null> {
  try {
    // A card whose picture is a member's photograph is in the private
    // bucket, so the stored URL downloads nothing. Sign it first — and note
    // that such a card can only ever be read from the bytes, never from the
    // url form below, which is why the fallback keeps the signed address.
    const [primary, secondary] = await signCardPhotos(admin, [imageUrl, altUrl]);
    const first = primary ?? imageUrl;
    let bytes = await imageBytes(first, report);
    if (!bytes && secondary && secondary !== first) bytes = await imageBytes(secondary, report);
    const source = bytes
      ? { type: "base64" as const, media_type: bytes.media_type, data: bytes.data }
      : { type: "url" as const, url: first };
    const client = anthropic();
    const read = await askForJson<{
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
    }>(
      client,
      {
        model: SCAN_MODEL,
        max_tokens: 2000,
        system: CARD_READ_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source },
              { type: "text", text: "Transcribe this card's game data." },
            ],
          },
        ],
      },
      CARD_READ_SCHEMA as unknown as Record<string, unknown>,
      {
        onResponse: (response) => {
          if (userId) return logAiUsage(admin, userId, "card_fx", SCAN_MODEL, response.usage);
        },
        report,
      }
    );
    if (!read) return null;
    if (!read.readable) {
      console.warn(`card read: the model called ${imageUrl} illegible`);
      report?.("the reader said the picture is too small or blurry to transcribe");
      return null;
    }
    return {
      // Sliced here, since the schema no longer does it — and it never
      // really did: a limit the API rejects is a limit that never ran.
      attacks: (read.attacks ?? []).slice(0, 4).map((a) => ({
        name: a.name,
        cost: Array.from({ length: Math.max(0, Math.min(5, a.cost_count)) }, () => "Colorless"),
        damage: a.damage ?? "",
        text: a.text || null,
      })),
      weak: read.weakness_type ? { type: read.weakness_type, value: "×2" } : null,
      resist: null,
      retreat: read.retreat ?? 0,
      ...(read.rules_text?.length ? { rules: read.rules_text.slice(0, 6) } : {}),
      ...(read.abilities?.length ? { abilities: read.abilities.slice(0, 3) } : {}),
      stage: read.stage,
      hp: read.hp,
      trainerType: read.trainer_type,
    };
  } catch (err) {
    // Loudly. This swallowed everything — a rejected image, a bad URL, a
    // rate limit, a malformed response — and every one of them reached the
    // screen as "reading it from the picture didn't work", with no way to
    // find out which. That is the difference between a card that can't be
    // read and a card we never actually sent.
    console.error(
      `card read: FAILED for ${imageUrl} — ${err instanceof Error ? err.message : String(err)}`
    );
    report?.(err instanceof Error ? err.message : "the read failed");
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

/** Sorted copy, so two lists of the same things compare equal whatever
 *  order the source happened to return them in. */
function sortedList(v: unknown): string {
  return JSON.stringify(Array.isArray(v) ? [...(v as string[])].sort() : (v ?? null));
}

/** One card's text, written to every other printing of the same card.
 *
 *  Mega Starmie ex ships in Perfect Order as a Double Rare (#21), an Ultra
 *  Rare (#102) and a Special Illustration Rare (#118). The artwork differs;
 *  the attacks, HP, weakness and retreat are the same words on every one of
 *  them. Reading each separately paid three times for one card's worth of
 *  information — and worse, spent the chat's two-reads-per-question budget
 *  on duplicates of a card it had just read, which is how a question about
 *  a popular card came back with no text at all.
 *
 *  Only rows that agree on everything printed except the picture are
 *  filled: same set, same name, same supertype, same HP, same types and
 *  subtypes. Two genuinely different cards agreeing on all of that inside
 *  one set is not a thing that happens; matching any more loosely is, and
 *  the failure mode is writing one card's attacks onto another card, which
 *  is worse than having no text at all.
 *
 *  Never overwrites: a row that already holds text keeps it. Best-effort
 *  throughout — the read it is copying already succeeded and was already
 *  saved, so nothing here is allowed to turn that into a failure.
 *
 *  Returns how many siblings were filled. */
export async function shareTextWithPrintings(
  admin: SupabaseClient,
  cardId: string,
  bd: CardBattleData
): Promise<number> {
  try {
    const cols = "id, name, set_name, supertype, subtypes, types, hp, battle_data";
    const { data: self } = await admin.from("cards").select(cols).eq("id", cardId).maybeSingle();
    if (!self?.name || !self?.set_name) return 0;

    const { data: rows } = await admin
      .from("cards")
      .select(cols)
      .eq("set_name", self.set_name)
      .eq("name", self.name);

    const ids = (rows ?? [])
      .filter(
        (r) =>
          r.id !== cardId &&
          r.battle_data == null &&
          r.supertype === self.supertype &&
          (r.hp ?? null) === (self.hp ?? null) &&
          sortedList(r.types) === sortedList(self.types) &&
          sortedList(r.subtypes) === sortedList(self.subtypes)
      )
      .map((r) => r.id as string);
    if (ids.length === 0) return 0;

    const { error } = await admin
      .from("cards")
      .update({ battle_data: bd, text_attempts: 0, text_failed_at: null })
      .in("id", ids);
    return error ? 0 : ids.length;
  } catch {
    return 0;
  }
}

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
  userId: string | null,
  /** Ignore the cool-off — somebody is looking at the card and asked.
   *
   *  The cool-off exists to stop a background job re-reading an unreadable
   *  card forever. It is the wrong rule for a person tapping "try again",
   *  who may well know something has changed — a better picture, or a fix to
   *  the reader itself. Every card that failed while a bug was in the reader
   *  is otherwise locked out for a week after the bug is gone. */
  opts?: { force?: boolean; report?: ReadReport }
): Promise<CardBattleData | null> {
  const art = card.image_large ?? card.image_small;
  if (!art) {
    opts?.report?.("this card has no picture stored, so there is nothing to read");
    return null;
  }

  const attempts = card.text_attempts ?? 0;
  if (!opts?.force && attempts >= MAX_TEXT_ATTEMPTS) {
    const failedAt = card.text_failed_at ? Date.parse(card.text_failed_at) : 0;
    if (Number.isFinite(failedAt) && Date.now() - failedAt < TEXT_COOL_OFF_MS) {
      // NOT a failed read — a read that never happened. The two looked
      // identical from outside, which is most of why this took three tries
      // to diagnose.
      opts?.report?.(
        `the last ${attempts} reads failed, so it's resting until the cool-off passes — "Try reading the picture again" skips that`
      );
      return null;
    }
  }

  const alt = art === card.image_large ? card.image_small : card.image_large;
  const bd = await readCardFromImage(art, userId, admin, opts?.report, alt ?? null);

  try {
    if (bd) {
      await admin
        .from("cards")
        .update({ battle_data: bd, text_attempts: 0, text_failed_at: null })
        .eq("id", card.id);
      // The same words are printed on every other printing of this card.
      // Copying them is what stops the next question paying to read the
      // alternate art of a card we just read.
      await shareTextWithPrintings(admin, card.id, bd);
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

/** Make sure a card has its printed text, spending as little as possible.
 *
 *  ONE ladder, in one place, because six call sites were each climbing their
 *  own version of it:
 *
 *    1. what we already hold — no request at all
 *    2. the card's own free database (pokemontcg.io, or TCGdex by id)
 *    3. its picture, read once, only when the caller allows it
 *
 *  Step 1 is the point. Every caller already checked battle_data before
 *  fetching, so a card we hold has never cost a request — but each of them
 *  re-implemented that check, and only the two newest remembered a FAILURE.
 *  So a card the free databases don't carry was re-requested on every deck
 *  build and every card-detail view, for ever, at no charge but no benefit
 *  either. Recording the miss is what turns a permanent gap into one lookup.
 *
 *  `allowVision` is off by default and deliberately so: a deck build warms
 *  150 cards at once, and a paid read each would be an expensive way to
 *  discover that a source is thin. Interactive callers, asking about one
 *  card somebody named, opt in.
 */
export async function ensureCardText(
  admin: SupabaseClient,
  card: {
    id: string;
    battle_data?: unknown;
    image_large?: string | null;
    image_small?: string | null;
    text_attempts?: number | null;
    text_failed_at?: string | null;
  },
  opts?: { allowVision?: boolean; userId?: string | null; force?: boolean; report?: ReadReport }
): Promise<CardBattleData | null> {
  // 1. Ours. (`force` skips even this: somebody asking to re-read a card
  //  that already has text would get the old text back otherwise.)
  if (card.battle_data && !opts?.force) return card.battle_data as CardBattleData;

  const id = card.id;
  if (id.startsWith("custom-")) {
    // A photo-scanned card has no database entry anywhere; its picture is
    // the only source there has ever been.
    return opts?.allowVision
      ? readCardTextOnce(admin, card, opts?.userId ?? null, {
          force: opts?.force,
          report: opts?.report,
        })
      : null;
  }

  // Nothing to gain from asking again inside the cool-off.
  const attempts = card.text_attempts ?? 0;
  if (!opts?.force && attempts >= MAX_TEXT_ATTEMPTS) {
    const failedAt = card.text_failed_at ? Date.parse(card.text_failed_at) : 0;
    if (Number.isFinite(failedAt) && Date.now() - failedAt < TEXT_COOL_OFF_MS) return null;
  }

  // 2. The card's own database — free.
  let bd: CardBattleData | null = null;
  try {
    bd = id.startsWith("tcgdex-")
      ? await getTcgdexBattleDataById(id)
      : await getBattleDataById(id);
  } catch {
    bd = null;
  }

  if (bd) {
    try {
      await admin
        .from("cards")
        .update({ battle_data: bd, text_attempts: 0, text_failed_at: null })
        .eq("id", id);
    } catch {
      await admin.from("cards").update({ battle_data: bd }).eq("id", id).then(() => {});
    }
    return bd;
  }

  // 3. The picture, if this caller is one that should pay for it.
  if (opts?.allowVision)
    return readCardTextOnce(admin, card, opts?.userId ?? null, {
      force: opts?.force,
      report: opts?.report,
    });

  // Remember the free miss, so the next build doesn't repeat it.
  try {
    await admin
      .from("cards")
      .update({ text_attempts: attempts + 1, text_failed_at: new Date().toISOString() })
      .eq("id", id);
  } catch {
    // Migration 050 hasn't run — the lookup still works, it just forgets.
  }
  return null;
}
