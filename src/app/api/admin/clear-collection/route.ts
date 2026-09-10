import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson, PublicError } from "@/lib/apiError";

// Empty one member's collection — the rescan-from-scratch path.
//
// Bulk-job uploads MERGE (quantities add to what's already there), so
// rescanning a collection through the rig without clearing first would
// double every card. Decks are unaffected by design: a deck stores card
// names and catalogue ids, never collection rows, so it re-lights as the
// rescan lands. What IS lost: per-copy notes, custom "your value" prices,
// and photo-backed custom cards — the UI says so before the button works.

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      confirm?: string;
      game?: string;
    };
    const email = (body.email ?? "").trim().toLowerCase();
    if (!email) throw new PublicError("Which member? Give the account email.");
    if (body.confirm !== "CLEAR") {
      throw new PublicError('Type CLEAR in the confirmation box to run this.');
    }
    const game = body.game === "pokemon" || body.game === "mtg" ? body.game : "all";
    const admin = createAdminClient();
    const { data: member } = await admin
      .from("profiles")
      .select("id, email")
      .ilike("email", email)
      .maybeSingle();
    if (!member) throw new PublicError(`No member with the email ${email}.`);

    // Game scope rides on the id scheme, like every other game filter in
    // the app: Magic catalogue rows are scry-…, everything else (Pokémon
    // sources and photo-backed custom cards) is not. Prefix rather than
    // the cards.game column so this works mid-migration too.
    const scoped = <T extends { eq: (c: string, v: string) => T; like: (c: string, p: string) => T; not: (c: string, op: string, p: string) => T }>(q: T) => {
      q = q.eq("user_id", member.id);
      if (game === "mtg") return q.like("card_id", "scry-%");
      if (game === "pokemon") return q.not("card_id", "like", "scry-%");
      return q;
    };
    const { count } = await scoped(
      admin.from("collection_items").select("id", { count: "exact", head: true })
    );
    const { error } = await scoped(admin.from("collection_items").delete());
    if (error) throw error;
    console.warn(`admin cleared collection (${game}): ${member.email} (${count ?? 0} rows)`);
    return NextResponse.json({ ok: true, member: member.email, game, removed: count ?? 0 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't clear the collection");
  }
}
