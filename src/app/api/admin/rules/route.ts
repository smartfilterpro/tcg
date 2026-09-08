import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { importRules } from "@/lib/rulesLibrary";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 120;

// Loading the rules library. MTG: paste the URL of the Comprehensive
// Rules TXT from magic.wizards.com/en/rules (it changes per set release).
// Pokémon: paste the rulebook's text. Either replaces that game's library
// wholesale — the rules are a document, not an accumulation.

/** GET — what's loaded: sections and latest import per game. */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const out: Record<string, { sections: number; updated: string | null }> = {};
    for (const game of ["pokemon", "mtg"] as const) {
      const { count, error } = await admin
        .from("rules_sections")
        .select("id", { count: "exact", head: true })
        .eq("game", game);
      if (error) return NextResponse.json({ pokemon: null, mtg: null, missing: true });
      const { data: latest } = await admin
        .from("rules_sections")
        .select("created_at")
        .eq("game", game)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      out[game] = { sections: count ?? 0, updated: (latest?.created_at as string) ?? null };
    }
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { game, url } or { game, text } — fetch/take the document and
 *  import it, replacing the game's current library. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      game?: string;
      url?: string;
      text?: string;
    };
    const game = body.game === "mtg" ? "mtg" : body.game === "pokemon" ? "pokemon" : null;
    if (!game) return NextResponse.json({ error: "Which game?" }, { status: 400 });

    let text = (body.text ?? "").trim();
    if (!text && body.url) {
      const url = body.url.trim();
      if (!/^https:\/\//.test(url)) {
        return NextResponse.json({ error: "The URL must be https." }, { status: 400 });
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        return NextResponse.json({ error: `Fetching the document failed: HTTP ${res.status}.` }, { status: 400 });
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 8_000_000) {
        return NextResponse.json({ error: "That file is over 8MB — not a rules text." }, { status: 400 });
      }
      text = Buffer.from(buf).toString("utf8");
    }
    if (text.length < 5000) {
      return NextResponse.json(
        { error: "That's too short to be a rules document — paste the full text or give the TXT's URL." },
        { status: 400 }
      );
    }

    const admin = createAdminClient();
    const { sections, shape } = await importRules(admin, game, text);
    return NextResponse.json({ ok: true, sections, shape });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE ?game= — clear one game's library. */
export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const game = new URL(req.url).searchParams.get("game") === "mtg" ? "mtg" : "pokemon";
    const admin = createAdminClient();
    const { error } = await admin.from("rules_sections").delete().eq("game", game);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return errorJson(err, "Request failed");
}
