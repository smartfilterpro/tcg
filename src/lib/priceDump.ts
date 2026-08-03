// Daily bulk price dumps from Pokémon Price Tracker (Business plan).
//
// One download replaces thousands of paginated lookups and costs ZERO API
// credits — it has its own quota of 2 downloads a day. That is the whole
// argument for it: priceRefresh.ts currently walks the catalogue stalest
// first, a few hundred cards a run, and the last production run found 51 of
// 120 cards with no price data. Not because the prices don't exist, but
// because we only ever ask about a sliver per day. This prices everything,
// every morning, for nothing.
//
// ── Off until switched on ────────────────────────────────────────────────
// POKEMONPRICETRACKER_EXPORTS=1 enables it. The account is on the Personal
// plan today and this endpoint is Business-only, so without the flag every
// call here would be a 403.
//
// ── What is and isn't verified ───────────────────────────────────────────
// The CSV parsing, gzip handling, printing key, batching and upsert are
// tested against synthetic dumps built to the documented column lists. The
// HTTP handshake — auth, the 302 to Vercel Blob, the 503-before-06:00 — is
// NOT: the plan we're on can't reach it. That is the same class of thing I
// got wrong twice today (a pokemontcg.io API version, an eBay OAuth path),
// so `runPriceDump({ dryRun: true })` downloads and parses and writes
// nothing, and should be the first thing run after upgrading.

import { gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DumpType = "cards" | "printings" | "sealed" | "ebay" | "population";

const BASE = (process.env.POKEMONPRICETRACKER_BASE ?? "https://www.pokemonpricetracker.com/api/v2")
  .trim()
  .replace(/\/$/, "");

export function exportsEnabled(): boolean {
  return (
    (process.env.POKEMONPRICETRACKER_EXPORTS ?? "").trim() === "1" &&
    (process.env.POKEMONPRICETRACKER_API_KEY ?? "").trim().length > 0
  );
}

/* -------------------------------------------------------------------- csv */

/** RFC 4180. Quoted fields may contain commas, newlines and "" escapes —
 *  card names contain commas and apostrophes constantly, so a split(",")
 *  parser would silently shift every column after the first such row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  // A final line without a trailing newline still counts.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").length > 0);
}

/** Rows as objects keyed by the header row. */
export function toRecords(csv: string): Array<Record<string, string>> {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = r[i] ?? "";
    });
    return rec;
  });
}

/* --------------------------------------------------------------- download */

export interface DumpResult {
  type: DumpType;
  rows: number;
  matched: number;
  updated: number;
  generatedAt: string | null;
  downloadsRemaining: string | null;
  dryRun: boolean;
  notes: string[];
}

export class DumpUnavailable extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = "DumpUnavailable";
  }
}

/** Fetch and decompress one dataset. */
export async function downloadDump(type: DumpType): Promise<{
  csv: string;
  generatedAt: string | null;
  downloadsRemaining: string | null;
}> {
  const key = (process.env.POKEMONPRICETRACKER_API_KEY ?? "").trim();
  const res = await fetch(`${BASE}/export?type=${encodeURIComponent(type)}`, {
    headers: { Authorization: `Bearer ${key}` },
    // fetch follows the 302 to Vercel Blob by default. The blob URL changes
    // daily, so it is never cached or stored — only followed.
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });

  if (res.status === 503) {
    // Before 06:00 UTC the day's dump may not exist. Does NOT count against
    // the 2/day quota, so retrying later is free.
    const after = Number(res.headers.get("retry-after"));
    throw new DumpUnavailable(
      "The dump for today hasn't been generated yet (it lands at 06:00 UTC).",
      Number.isFinite(after) ? after : 3600
    );
  }
  if (res.status === 403) {
    throw new Error("403 — the bulk export is a Business-plan endpoint.");
  }
  if (res.status === 429) {
    throw new Error("429 — both of today's two downloads are used.");
  }
  if (!res.ok) {
    throw new Error(`export ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // Gzip magic. Checked rather than assumed: if they ever serve the CSV
  // uncompressed, gunzip throws a decode error that says nothing useful.
  const csv =
    buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");

  return {
    csv,
    generatedAt: res.headers.get("x-dump-generated-at"),
    downloadsRemaining: res.headers.get("x-export-downloads-remaining"),
  };
}

/* ---------------------------------------------------------------- applying */

const num = (v: string | undefined): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Apply a cards/printings dump to our catalogue.
 *
 *  Matched on tcgplayer_id, which is why migration 033 exists. Rows we can't
 *  match are counted, not guessed at — a fuzzy name match here would write
 *  the wrong price to the wrong card, which is worse than no price.
 *
 *  `printings` is the one to use: `cards` carries only each card's primary
 *  printing, leaving ~29% of the catalogue's other printings unpriced, and
 *  we model per-finish prices. Keyed on tcgPlayerId + printing.
 */
export async function applyCardDump(
  admin: SupabaseClient,
  records: Array<Record<string, string>>,
  opts: { dryRun: boolean }
): Promise<{ matched: number; updated: number; notes: string[] }> {
  const notes: string[] = [];

  // Group by card: one row per printing, folded into the per-finish price map
  // our cards table already uses.
  const byCard = new Map<string, { market: number | null; prices: Record<string, number> }>();
  for (const r of records) {
    const id = (r.tcgPlayerId ?? "").trim();
    if (!id) continue;
    const market = num(r.marketPrice);
    const printing = (r.printing ?? "").trim() || "normal";
    const entry = byCard.get(id) ?? { market: null, prices: {} };
    if (market != null) {
      entry.prices[printing] = market;
      // The primary printing's row is the one with `sellers` populated —
      // card-level, blank on additional printing rows. Use it for the
      // headline price rather than whichever printing happened to be last.
      if (entry.market == null || (r.sellers ?? "").trim() !== "") entry.market = market;
    }
    byCard.set(id, entry);
  }

  const ids = [...byCard.keys()];
  if (ids.length === 0) return { matched: 0, updated: 0, notes: ["No usable rows."] };

  // Which of these we actually hold. Chunked: `in` with tens of thousands of
  // ids is a URL no server will accept.
  const CHUNK = 500;
  const ours = new Map<string, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await admin
      .from("cards")
      .select("id, tcgplayer_id")
      .in("tcgplayer_id", ids.slice(i, i + CHUNK));
    for (const row of data ?? []) {
      ours.set(row.tcgplayer_id as string, row.id as string);
    }
  }

  const matched = ours.size;
  notes.push(
    `${matched.toLocaleString()} of ${ids.length.toLocaleString()} dump cards are mapped to ours` +
      (matched === 0
        ? " — nothing has a tcgplayer_id yet, so the mapping needs backfilling first."
        : "")
  );

  if (opts.dryRun) return { matched, updated: 0, notes: [...notes, "Dry run: nothing written."] };

  let updated = 0;
  // Rows carrying no usable price are dropped rather than written.
  //
  // A dump row whose every printing failed to parse leaves market null and
  // the map empty, and writing that would blank a price another source had
  // already found — the same way the catalogue import used to. A price
  // update that removes a price is not an update.
  const priced = [...ours.entries()].filter(([tcgId]) => {
    const e = byCard.get(tcgId)!;
    return e.market != null || Object.keys(e.prices).length > 0;
  });
  const skipped = ours.size - priced.length;
  if (skipped > 0) notes.push(`${skipped.toLocaleString()} had no usable price and were left alone.`);
  const updates = priced.map(([tcgId, cardId]) => ({
    id: cardId,
    market_price: byCard.get(tcgId)!.market,
    prices: byCard.get(tcgId)!.prices,
    price_updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200);
    // Per-row updates, not an upsert: an upsert would need every NOT NULL
    // column and would happily insert a half-empty card row for anything
    // whose id drifted.
    for (const u of batch) {
      const { error } = await admin
        .from("cards")
        .update({
          market_price: u.market_price,
          prices: u.prices,
          price_updated_at: u.price_updated_at,
        })
        .eq("id", u.id);
      if (!error) updated += 1;
    }
  }
  return { matched, updated, notes };
}

/** Download and apply one dataset. */
export async function runPriceDump(
  admin: SupabaseClient,
  opts: { type?: DumpType; dryRun?: boolean } = {}
): Promise<DumpResult> {
  const type = opts.type ?? "printings";
  const dryRun = opts.dryRun !== false;

  if (!exportsEnabled()) {
    throw new Error(
      "Bulk exports are off — set POKEMONPRICETRACKER_EXPORTS=1 once the account is on the Business plan."
    );
  }

  const { csv, generatedAt, downloadsRemaining } = await downloadDump(type);
  const records = toRecords(csv);

  if (type !== "cards" && type !== "printings") {
    // Downloaded and parsed, but there is nowhere to put sealed/ebay/
    // population data yet. Reported honestly rather than silently discarded.
    return {
      type,
      rows: records.length,
      matched: 0,
      updated: 0,
      generatedAt,
      downloadsRemaining,
      dryRun,
      notes: [`Parsed ${records.length.toLocaleString()} rows. No importer for "${type}" yet.`],
    };
  }

  const applied = await applyCardDump(admin, records, { dryRun });
  return {
    type,
    rows: records.length,
    matched: applied.matched,
    updated: applied.updated,
    generatedAt,
    downloadsRemaining,
    dryRun,
    notes: applied.notes,
  };
}
