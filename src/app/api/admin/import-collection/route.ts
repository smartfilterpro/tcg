import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCsv } from "@/lib/priceDump";
import { numberKey } from "@/lib/pokemontcg";
import { normalizeForSearch } from "@/lib/text";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 120;

// Admin bulk-load: a CSV of cards straight into one member's collection —
// for seeding a test account with a realistic collection without scanning
// 800 cards by hand.
//
// Matching is against OUR catalogue only, and a row either matches exactly
// one card or it is reported, never guessed: silently loading the wrong
// printing would poison whatever experiment the test collection is for.
// Dry run by default, like every admin tool that writes to someone's data.

const MAX_ROWS = 2000;

interface CsvRow {
  line: number;
  name: string;
  number: string;
  set: string;
  qty: number;
  variant: string;
}

/** Flexible header mapping — exports from other tools name columns
 *  differently, and demanding our exact spelling would mean hand-editing
 *  the file, which is the chore this endpoint exists to remove. */
const HEADER_ALIASES: Record<string, keyof Omit<CsvRow, "line">> = {
  name: "name", card: "name", "card name": "name", cardname: "name",
  number: "number", no: "number", "#": "number", "card number": "number", num: "number",
  set: "set", "set name": "set", setname: "set", edition: "set", expansion: "set",
  qty: "qty", quantity: "qty", count: "qty", copies: "qty",
  variant: "variant", finish: "variant", printing: "variant", foil: "variant",
};

const KNOWN_VARIANTS = new Set([
  "normal", "holofoil", "reverse_holofoil", "holo", "reverse", "reverse holo",
  "1st_edition", "first edition", "unlimited",
]);

function canonicalVariant(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v || !KNOWN_VARIANTS.has(v)) return "normal";
  if (v === "holo") return "holofoil";
  if (v === "reverse" || v === "reverse holo") return "reverse_holofoil";
  if (v === "first edition") return "1st_edition";
  return v;
}

function parseRows(csv: string): { rows: CsvRow[]; problems: string[] } {
  const raw = parseCsv(csv);
  const problems: string[] = [];
  if (raw.length < 2) return { rows: [], problems: ["The file needs a header row and at least one card row."] };

  const header = raw[0].map((h) => h.trim().toLowerCase());
  const cols = new Map<keyof Omit<CsvRow, "line">, number>();
  header.forEach((h, i) => {
    const key = HEADER_ALIASES[h];
    if (key && !cols.has(key)) cols.set(key, i);
  });
  if (!cols.has("name")) {
    return { rows: [], problems: [`No name column found — headers seen: ${header.join(", ")}.`] };
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (r.every((c) => !c.trim())) continue;
    const get = (k: keyof Omit<CsvRow, "line">) => {
      const idx = cols.get(k);
      return idx == null ? "" : (r[idx] ?? "").trim();
    };
    const name = get("name");
    if (!name) {
      problems.push(`Line ${i + 1}: no card name.`);
      continue;
    }
    const qtyRaw = get("qty");
    const qty = qtyRaw ? parseInt(qtyRaw.replace(/\D/g, ""), 10) : 1;
    rows.push({
      line: i + 1,
      name,
      number: get("number"),
      set: get("set"),
      qty: Number.isFinite(qty) && qty > 0 ? Math.min(qty, 999) : 1,
      variant: canonicalVariant(get("variant")),
    });
  }
  if (rows.length > MAX_ROWS) {
    problems.push(`${rows.length} rows — capped at ${MAX_ROWS}; split the file.`);
    rows.length = MAX_ROWS;
  }
  return { rows, problems };
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as { email?: string; csv?: string; dryRun?: boolean };
    const dryRun = body.dryRun !== false;
    const email = (body.email ?? "").trim().toLowerCase();
    const csv = body.csv ?? "";
    if (!email) return NextResponse.json({ error: "Which member? Give their email." }, { status: 400 });
    if (!csv.trim()) return NextResponse.json({ error: "Paste or upload a CSV first." }, { status: 400 });
    if (csv.length > 2_000_000) {
      return NextResponse.json({ error: "That file is over 2MB — split it." }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("id, email, display_name")
      .ilike("email", email)
      .maybeSingle();
    if (!profile) {
      return NextResponse.json({ error: `No member with the email ${email}.` }, { status: 404 });
    }

    const { rows, problems } = parseRows(csv);
    if (rows.length === 0) {
      return NextResponse.json({ error: problems[0] ?? "No usable rows found." }, { status: 400 });
    }

    // One catalogue fetch for all names (chunked exact-insensitive match),
    // indexed the same way the price sync matches: normalized name + zeroless
    // number. Set name, when the CSV has one, breaks ties.
    const wantedNames = [...new Set(rows.map((r) => normalizeForSearch(r.name)))];
    type CardHit = { id: string; name: string; number: string; set_name: string | null };
    const byName = new Map<string, CardHit[]>();
    const CHUNK = 100;
    const distinctRaw = [...new Set(rows.map((r) => r.name))];
    for (let i = 0; i < distinctRaw.length; i += CHUNK) {
      const slice = distinctRaw.slice(i, i + CHUNK);
      // ilike-any via or() would choke on commas in names; fetch per-chunk
      // with .in() on the raw spelling AND collect case-variants after.
      const { data } = await admin
        .from("cards")
        .select("id, name, number, set_name")
        .in("name", slice);
      for (const c of (data ?? []) as CardHit[]) {
        const k = normalizeForSearch(c.name);
        const list = byName.get(k);
        if (list) list.push(c);
        else byName.set(k, [c]);
      }
    }
    // Names the exact pass missed (case/punctuation differences): one ilike
    // query each, capped so a garbage file can't turn into 2,000 queries.
    const missing = wantedNames.filter((n) => !byName.has(n));
    for (const norm of missing.slice(0, 300)) {
      const rawName = rows.find((r) => normalizeForSearch(r.name) === norm)?.name ?? norm;
      const { data } = await admin
        .from("cards")
        .select("id, name, number, set_name")
        .ilike("name", rawName.replace(/[%_]/g, " "))
        .limit(50);
      const hits = ((data ?? []) as CardHit[]).filter(
        (c) => normalizeForSearch(c.name) === norm
      );
      if (hits.length > 0) byName.set(norm, hits);
    }

    let matched = 0;
    let added = 0;
    let updated = 0;
    const unmatched: Array<{ line: number; name: string; reason: string }> = [];

    for (const row of rows) {
      const candidates = byName.get(normalizeForSearch(row.name)) ?? [];
      let hits = candidates;
      if (row.number) {
        const key = numberKey(row.number);
        hits = hits.filter((c) => numberKey(c.number) === key);
      }
      if (row.set && hits.length > 1) {
        const set = normalizeForSearch(row.set);
        const bySet = hits.filter((c) => normalizeForSearch(c.set_name ?? "").includes(set));
        if (bySet.length > 0) hits = bySet;
      }
      if (hits.length === 0) {
        unmatched.push({
          line: row.line,
          name: `${row.name}${row.number ? ` #${row.number}` : ""}`,
          reason: candidates.length === 0 ? "not in the catalogue" : "no printing with that number",
        });
        continue;
      }
      if (hits.length > 1 && !row.number && !row.set) {
        unmatched.push({
          line: row.line,
          name: row.name,
          reason: `${hits.length} printings — add a number or set column to pick one`,
        });
        continue;
      }
      // Several survivors with a number given: same physical card held under
      // sibling records (sources spelling the set differently) — any is right.
      const card = hits[0];
      matched++;

      if (dryRun) continue;
      const { error: insErr } = await admin.from("collection_items").insert({
        user_id: profile.id,
        card_id: card.id,
        quantity: row.qty,
        variant: row.variant,
      });
      if (!insErr) {
        added++;
        continue;
      }
      // Already owned in this finish — add the quantities together.
      const { data: existing } = await admin
        .from("collection_items")
        .select("id, quantity")
        .eq("user_id", profile.id)
        .eq("card_id", card.id)
        .eq("variant", row.variant)
        .maybeSingle();
      if (existing) {
        const { error: qtyErr } = await admin
          .from("collection_items")
          .update({ quantity: (existing.quantity as number) + row.qty })
          .eq("id", existing.id);
        if (!qtyErr) updated++;
        else unmatched.push({ line: row.line, name: row.name, reason: qtyErr.message });
      } else {
        unmatched.push({ line: row.line, name: row.name, reason: insErr.message });
      }
    }

    return NextResponse.json({
      dryRun,
      member: (profile.display_name as string | null) || (profile.email as string),
      rows: rows.length,
      matched,
      added,
      updated,
      unmatched: unmatched.slice(0, 25),
      unmatchedTotal: unmatched.length,
      problems,
      note: dryRun
        ? "Nothing written — this is the preview. Apply to load the matched rows."
        : "Loaded. The member sees the cards in their collection immediately.",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Import failed");
  }
}
