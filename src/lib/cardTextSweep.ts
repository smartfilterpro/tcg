// Reading the catalogue's printed text, card by card.
//
// Until now text arrived only when somebody asked for it: a chat question,
// a card entering a battle, a refresh. Nothing swept. So a card nobody had
// asked about had no text, which is most of the catalogue — and the cards
// people ask about most are the newest ones, exactly where the free
// databases have nothing yet and the picture is the only source.
//
// This walks the catalogue and fills the gap. Same shape as artMirror: one
// HTTP request per batch, a cursor the client holds, so a stopped run
// resumes where it left off and no single request outlives the proxy.
//
// The ladder per card is the cheap-first one the rest of the app uses:
//
//   1. the card's own free database (pokemontcg.io, or TCGdex by id)
//   2. its picture, read by the model — paid, and rationed per batch
//
// and every success is copied to the card's other printings, which is what
// makes the whole job affordable. A chase card with four printings costs
// one read, not four.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";
import { getBattleDataById } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";
import { readCardTextOnce, shareTextWithPrintings } from "@/lib/cardText";

/** How many rows to examine per request. Cheap: one indexed page. */
const SCAN_WINDOW = 400;

/** How many cards may be sent to the model in one batch. This is the only
 *  line in the job that costs money, so it is the one with a number on it.
 *  Ten reads is a few cents and finishes inside the request timeout even
 *  when every one of them is slow. */
const VISION_PER_BATCH = 10;

/** How many free-database lookups per batch. Free in money, not in time —
 *  each is an HTTP round trip to somebody else's server. */
const FREE_PER_BATCH = 60;

/** Pause between free-database lookups: this walks other people's servers
 *  by the thousand, and the polite pace is also the one that doesn't get us
 *  rate-limited half way through a set. */
const FREE_INTERVAL_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TextStatus {
  /** Cards in the catalogue. */
  total: number;
  /** …that already hold their printed text. */
  withText: number;
  /** …that don't. */
  missing: number;
  /** Of those, how many are resting after failed reads. */
  cooling: number;
  /** …and how many are owned by somebody, which is the set worth doing
   *  first: a card in a collection is a card that gets asked about. */
  ownedMissing: number;
}

async function countRows(
  admin: SupabaseClient,
  build: (q: ReturnType<SupabaseClient["from"]>) => unknown
): Promise<number> {
  const q = build(admin.from("cards")) as { count?: number | null };
  const res = (await q) as unknown as { count: number | null };
  return res.count ?? 0;
}

/** How much of the catalogue can say what it does. */
export async function textStatus(admin: SupabaseClient): Promise<TextStatus> {
  const head = { count: "exact" as const, head: true };
  const coolOffFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [total, withText, cooling] = await Promise.all([
    countRows(admin, (t) => t.select("id", head)),
    countRows(admin, (t) => t.select("id", head).not("battle_data", "is", null)),
    countRows(admin, (t) =>
      t
        .select("id", head)
        .is("battle_data", null)
        .gte("text_attempts", 2)
        .gte("text_failed_at", coolOffFrom)
    ).catch(() => 0),
  ]);

  // Owned-and-missing needs the owned set, which lives in another table.
  // Distinct is done here rather than in SQL because PostgREST has no
  // DISTINCT — the id list is small next to the catalogue either way.
  let ownedMissing = 0;
  try {
    const { data: owned } = await fetchAllRows<{ card_id: string }>(() =>
      admin.from("collection_items").select("card_id").order("card_id")
    );
    const ids = [...new Set(owned.map((o) => o.card_id).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 300) {
      ownedMissing += await countRows(admin, (t) =>
        t.select("id", head).is("battle_data", null).in("id", ids.slice(i, i + 300))
      );
    }
  } catch {
    // Best-effort: the headline numbers are still worth showing.
  }

  return { total, withText, missing: total - withText, cooling, ownedMissing };
}

export interface TextBatchResult {
  /** Rows looked at this batch. */
  examined: number;
  /** Cards that gained text from a free database. */
  fromDatabase: number;
  /** Cards that gained text from their picture — the paid ones. */
  fromPicture: number;
  /** Other printings filled for free by copying a read. */
  shared: number;
  /** Cards that had no text and could not be given any. */
  failed: Array<{ id: string; name: string; reason: string }>;
  /** Cursor for the next batch, or null at the end of the catalogue. */
  next: string | null;
  done: boolean;
}

interface Row {
  id: string;
  name: string | null;
  set_name: string | null;
  image_small: string | null;
  image_large: string | null;
  battle_data: unknown;
  text_attempts: number | null;
  text_failed_at: string | null;
}

/** One batch. `after` is the last card id examined; pass null to start.
 *
 *  `ownedOnly` restricts the batch to cards somebody actually has. The
 *  cursor still walks the whole catalogue in id order, so the two modes
 *  share a position and switching between them mid-run is harmless.
 *
 *  `userId` is whose ledger the reads are logged against — an admin's.
 *  They land on the `card_fx` endpoint, which is deliberately unmetered:
 *  the result is written to the shared catalogue for everybody, so it is
 *  infrastructure rather than one person's spend. */
export async function textBatch(
  admin: SupabaseClient,
  after: string | null,
  opts: { ownedOnly?: boolean; userId: string | null }
): Promise<TextBatchResult> {
  let q = admin
    .from("cards")
    .select("id, name, set_name, image_small, image_large, battle_data, text_attempts, text_failed_at")
    .order("id")
    .limit(SCAN_WINDOW);
  if (after) q = q.gt("id", after);
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) {
    return { examined: 0, fromDatabase: 0, fromPicture: 0, shared: 0, failed: [], next: null, done: true };
  }
  const cursor = rows[rows.length - 1].id;

  let candidates = rows.filter((r) => r.battle_data == null && !r.id.startsWith("custom-"));

  if (opts.ownedOnly && candidates.length > 0) {
    // One query per window rather than the whole collection: we only care
    // whether these particular cards are owned.
    const { data: owned } = await admin
      .from("collection_items")
      .select("card_id")
      .in("card_id", candidates.map((c) => c.id));
    const has = new Set((owned ?? []).map((o) => o.card_id as string));
    candidates = candidates.filter((c) => has.has(c.id));
  }

  const result: TextBatchResult = {
    examined: rows.length,
    fromDatabase: 0,
    fromPicture: 0,
    shared: 0,
    failed: [],
    next: cursor,
    done: rows.length < SCAN_WINDOW,
  };

  let freeUsed = 0;
  let visionUsed = 0;
  // Cards filled by a sibling earlier in this same batch — the commonest
  // case in a set where every chase card has three printings, and skipping
  // them is the difference between one read and four.
  const filledHere = new Set<string>();

  for (const card of candidates) {
    if (filledHere.has(card.id)) continue;
    if (freeUsed >= FREE_PER_BATCH && visionUsed >= VISION_PER_BATCH) break;

    let bd = null as Awaited<ReturnType<typeof getBattleDataById>>;

    if (freeUsed < FREE_PER_BATCH) {
      freeUsed += 1;
      try {
        bd = card.id.startsWith("tcgdex-")
          ? await getTcgdexBattleDataById(card.id)
          : await getBattleDataById(card.id);
      } catch {
        bd = null;
      }
      await sleep(FREE_INTERVAL_MS);
    }

    if (bd) {
      await admin
        .from("cards")
        .update({ battle_data: bd, text_attempts: 0, text_failed_at: null })
        .eq("id", card.id);
      result.fromDatabase += 1;
      const n = await shareTextWithPrintings(admin, card.id, bd);
      result.shared += n;
      if (n > 0) for (const c of candidates) if (c.name === card.name) filledHere.add(c.id);
      continue;
    }

    if (visionUsed >= VISION_PER_BATCH) continue;
    if (!card.image_large && !card.image_small) {
      result.failed.push({ id: card.id, name: card.name ?? card.id, reason: "no picture stored" });
      continue;
    }
    visionUsed += 1;
    // readCardTextOnce honours the cool-off, writes both outcomes, and
    // shares a success across printings itself.
    const read = await readCardTextOnce(admin, card, opts.userId);
    if (read) {
      result.fromPicture += 1;
      for (const c of candidates) if (c.name === card.name) filledHere.add(c.id);
    } else {
      result.failed.push({
        id: card.id,
        name: card.name ?? card.id,
        reason: "couldn't read the picture",
      });
    }
  }

  return result;
}
