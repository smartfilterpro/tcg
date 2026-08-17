import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCardLines } from "@/lib/meta";
import { errorJson } from "@/lib/apiError";

// Curating the meta by hand. The nightly Limitless pull is the intended
// source, but curated rows are what make the feature real on day one and
// what keeps it real if the feed changes shape — so an admin can write an
// archetype directly, and a curated row is never overwritten by the sync.

const tableMissing = (err: unknown) =>
  /meta_decks/i.test(err instanceof Error ? err.message : String(err ?? ""));

export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("meta_decks")
      .select("*")
      .order("share", { ascending: false, nullsFirst: false })
      .order("archetype");
    if (error) throw error;
    return NextResponse.json({ migrated: true, decks: data ?? [] });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (tableMissing(err)) return NextResponse.json({ migrated: false, decks: [] });
    return errorJson(err, "Couldn't load meta decks.");
  }
}

/** POST: create or update one archetype.
 *  Body: { archetype, format?, share?, notes?, cardsText } — cardsText is
 *  one card per line, "4 Charizard ex". */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as {
      archetype?: string;
      format?: string;
      share?: number | null;
      notes?: string | null;
      cardsText?: string;
    };
    const archetype = (body.archetype ?? "").trim();
    const format = (body.format ?? "standard").trim().toLowerCase();
    if (!archetype || archetype.length > 80) {
      return NextResponse.json({ error: "Archetype name required." }, { status: 400 });
    }
    const { cards, bad } = parseCardLines(body.cardsText ?? "");
    if (bad.length > 0) {
      return NextResponse.json(
        { error: `Couldn't read: ${bad.slice(0, 3).join(" · ")}` },
        { status: 400 }
      );
    }
    if (cards.length === 0) {
      return NextResponse.json({ error: "At least one card line." }, { status: 400 });
    }
    const share =
      body.share == null || Number.isNaN(Number(body.share))
        ? null
        : Math.min(100, Math.max(0, Number(body.share)));

    const admin = createAdminClient();
    // Manual upsert: the unique index is on lower(archetype), which
    // PostgREST's ON CONFLICT can't name. Volume is a handful of rows.
    const { data: existing } = await admin
      .from("meta_decks")
      .select("id")
      .eq("format", format)
      .ilike("archetype", archetype.replace(/[%_]/g, ""))
      .maybeSingle();
    const row = {
      archetype,
      format,
      share,
      notes: (body.notes ?? "").trim() || null,
      core_cards: cards,
      source: "curated", // an admin edit claims the row from the sync
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const { error } = await admin.from("meta_decks").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await admin.from("meta_decks").insert(row);
      if (error) throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (tableMissing(err)) {
      return NextResponse.json(
        { error: "Run migration 068 first — the meta_decks table doesn't exist yet." },
        { status: 400 }
      );
    }
    return errorJson(err, "Couldn't save the archetype.");
  }
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "Need an id." }, { status: 400 });
    const admin = createAdminClient();
    const { error } = await admin.from("meta_decks").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't delete that archetype.");
  }
}
