import { NextResponse } from "next/server";
import { requireModerator, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson } from "@/lib/apiError";

// Moderation over shared decks — the deck names every member can see on the
// Friends page. The admin sees ALL shared decks here (service role), not
// just the ones RLS would show their own account: pals-only decks between
// two other members are exactly where an inappropriate name would otherwise
// hide from moderation.

/** GET: every shared deck, newest first, with its owner. */
export async function GET() {
  try {
    await requireModerator();
    const admin = createAdminClient();
    const { data: decks, error } = await admin
      .from("decks")
      .select("id, user_id, name, shared, share_scope, created_at")
      .eq("shared", true)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const ownerIds = [...new Set((decks ?? []).map((d) => d.user_id as string))];
    const names = new Map<string, string>();
    if (ownerIds.length > 0) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, email, display_name")
        .in("id", ownerIds);
      for (const p of profiles ?? []) {
        names.set(
          p.id as string,
          ((p.display_name as string | null)?.trim() || (p.email as string)) as string
        );
      }
    }
    return NextResponse.json({
      decks: (decks ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        scope: d.share_scope === "friends" ? "pals only" : "everyone",
        ownerId: d.user_id,
        ownerName: names.get(d.user_id as string) ?? "A member",
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { action: "rename"|"unshare", deckId, name? } */
export async function POST(req: Request) {
  try {
    await requireModerator();
    const body = (await req.json()) as { action?: string; deckId?: string; name?: string };
    if (!body.deckId || typeof body.deckId !== "string") {
      return NextResponse.json({ error: "Missing deckId" }, { status: 400 });
    }
    const admin = createAdminClient();

    if (body.action === "rename") {
      const name = (body.name ?? "").trim();
      if (!name || name.length > 100) {
        return NextResponse.json({ error: "Give the deck a name (max 100 chars)." }, { status: 400 });
      }
      const { error } = await admin.from("decks").update({ name }).eq("id", body.deckId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (body.action === "unshare") {
      const { error } = await admin
        .from("decks")
        .update({ shared: false })
        .eq("id", body.deckId);
      if (error) throw error;
      await admin.from("deck_shares").delete().eq("deck_id", body.deckId).then(() => {});
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
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
