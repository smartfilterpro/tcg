import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson } from "@/lib/apiError";
import { normalizeForSearch } from "@/lib/text";

// Triage for "a bunch of cards are missing": every unresolved review row
// whose read produced a name, grouped and checked against the catalogue,
// so each group carries a verdict — the card ISN'T in the catalogue
// (an import gap: fill it, no bug) or it IS (the matcher left it behind:
// possibly a bug, worth opening the row). Sorted by how many scans hit
// the same wall, which is the priority order for fixing anything.

export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const { data: rows } = await admin
      .from("bulk_cards")
      .select("job_id, seq, pass1_read, review_note")
      .is("card_id", null)
      .eq("reviewed", false)
      .not("pass1_read", "is", null)
      .order("updated_at", { ascending: false })
      .limit(2000);

    interface Group {
      name: string;
      number: string;
      total: number | null;
      game: string;
      count: number;
      note: string | null;
      example: { job: string; seq: number };
    }
    const groups = new Map<string, Group>();
    for (const r of rows ?? []) {
      const read = r.pass1_read as {
        name?: string;
        number?: string;
        game?: string;
        error?: string;
      } | null;
      const name = (read?.name ?? "").trim();
      if (!name || read?.error) continue;
      const [printedRaw, totalRaw] = (read?.number ?? "").split("/");
      const printed = (printedRaw ?? "").trim();
      const total = parseInt((totalRaw ?? "").trim(), 10);
      const key = `${normalizeForSearch(name)}|${printed}|${Number.isFinite(total) ? total : ""}`;
      const g = groups.get(key);
      if (g) g.count++;
      else {
        groups.set(key, {
          name,
          number: printed,
          total: Number.isFinite(total) ? total : null,
          game: read?.game === "mtg" ? "mtg" : "pokemon",
          count: 1,
          note: (r.review_note as string | null) ?? null,
          example: { job: r.job_id as string, seq: r.seq as number },
        });
      }
    }

    const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 40);
    const out = await Promise.all(
      top.map(async (g) => {
        // Does anything in the catalogue answer this read? Name first,
        // then the number-line fingerprint — the same doors the matcher
        // tries, checked independently so a disagreement means a bug.
        const isMtg = g.game === "mtg";
        let inCatalogue = false;
        const { data: byName } = await admin
          .from("cards")
          .select("id")
          .ilike("name", `%${g.name.replace(/[%_]/g, " ")}%`)
          .limit(10);
        inCatalogue = (byName ?? []).some((c) => (c.id as string).startsWith("scry-") === isMtg);
        let lineExists = false;
        if (!inCatalogue && g.number && g.total) {
          const forms = [
            ...new Set([g.number, g.number.replace(/^0+/, "") || g.number, g.number.padStart(3, "0")]),
          ];
          const { data: byLine } = await admin
            .from("cards")
            .select("id")
            .in("number", forms)
            .eq("set_printed_total", g.total)
            .limit(10);
          lineExists = (byLine ?? []).some((c) => (c.id as string).startsWith("scry-") === isMtg);
        }
        return {
          ...g,
          verdict: inCatalogue
            ? "in catalogue by name — matcher left it: check the row (possible bug)"
            : lineExists
              ? "number line exists in catalogue — name read is off: photo arbitration should catch it after a Re-read"
              : "not in the catalogue — an import gap, not a bug",
        };
      })
    );

    return NextResponse.json({ unresolved: (rows ?? []).length, groups: out });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't analyze scan gaps");
  }
}
