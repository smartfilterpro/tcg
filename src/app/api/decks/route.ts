import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { isFreeTier } from "@/lib/credits";
import { FREE_DECK_LIMIT } from "@/lib/limits";
import { nameAllowed, recordNameAttempt } from "@/lib/moderation";
import type { Deck, DeckCardEntry, DeckSuggestion } from "@/lib/types";
import { errorJson } from "@/lib/apiError";

/** The rest of the household's decks, read-only, with whose they are.
 *
 *  Deliberately read through the caller's own client rather than the service
 *  role: migration 060's policy is what decides this, so the list and the
 *  deck page can't disagree about who may see what. Before that migration
 *  runs the policy simply isn't there and this comes back empty, which is the
 *  right way for a missing migration to fail.
 *
 *  The group lookup uses the service role because family_members is
 *  deliberately unreadable by clients — a kid must not be able to enumerate
 *  or edit the household. Names come the same way, and only for the handful
 *  of people already established to be in the group. */
async function householdDecks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<Deck[]> {
  try {
    const admin = createAdminClient();
    const { data: mine } = await admin
      .from("family_members")
      .select("group_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!mine) return [];

    const { data: members } = await admin
      .from("family_members")
      .select("user_id")
      .eq("group_id", mine.group_id);
    const others = (members ?? [])
      .map((m) => m.user_id as string)
      .filter((id) => id !== userId);
    if (others.length === 0) return [];

    const [{ data: decks }, { data: profiles }] = await Promise.all([
      supabase
        .from("decks")
        .select("*")
        .in("user_id", others)
        .order("created_at", { ascending: false }),
      admin.from("profiles").select("id, display_name, email").in("id", others),
    ]);

    const nameById = new Map(
      (profiles ?? []).map((p) => [
        p.id as string,
        ((p.display_name as string | null) ?? "").trim() ||
          ((p.email as string) ?? "").split("@")[0],
      ])
    );
    return (decks ?? []).map((d) => ({
      ...(d as Deck),
      owner_name: nameById.get(d.user_id as string) ?? "Someone",
    }));
  } catch {
    // A household without decks is a small loss; a decks page that won't load
    // is a large one. Never let this take the user's own list down with it.
    return [];
  }
}

export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const [{ data, error }, family] = await Promise.all([
      supabase
        .from("decks")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      householdDecks(supabase, user.id),
    ]);
    if (error) throw error;
    return NextResponse.json({ decks: data ?? [], family });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const body = (await req.json()) as {
      name?: string;
      strategy?: string;
      cards?: DeckCardEntry[];
      suggestions?: DeckSuggestion[];
    };
    if (!body.name?.trim() || !Array.isArray(body.cards) || body.cards.length === 0) {
      return NextResponse.json({ error: "Name and cards are required" }, { status: 400 });
    }
    const suggestions = Array.isArray(body.suggestions) ? body.suggestions.slice(0, 10) : [];
    // Deck names show on the Friends page when shared — screened at save,
    // not at share, so an inappropriate name never sits waiting to be shared.
    const verdict = await nameAllowed("deck name", body.name);
    recordNameAttempt(user.id, "deck name", body.name, verdict);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.reason }, { status: 400 });
    }
    const supabase = await createClient();

    // The free tier keeps a shelf, not a library. Enforced here, not just in
    // the UI, and counted at save time so deleting a deck immediately frees
    // the slot.
    if (await isFreeTier(user, profile)) {
      const { count } = await supabase
        .from("decks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      if ((count ?? 0) >= FREE_DECK_LIMIT) {
        return NextResponse.json(
          {
            error:
              `Free accounts keep up to ${FREE_DECK_LIMIT} saved decks. ` +
              `Delete one you've outgrown, or upgrade for unlimited decks.`,
            code: "deck_limit",
          },
          { status: 403 }
        );
      }
    }
    let { data, error } = await supabase
      .from("decks")
      .insert({
        user_id: user.id,
        name: body.name.trim(),
        strategy: body.strategy ?? null,
        cards: body.cards,
        suggestions,
      })
      .select()
      .single();
    // Graceful pre-migration fallback: save without suggestions rather than
    // failing the whole deck save if migration 006 hasn't been run yet.
    if (error && /suggestions/i.test(error.message ?? "")) {
      ({ data, error } = await supabase
        .from("decks")
        .insert({
          user_id: user.id,
          name: body.name.trim(),
          strategy: body.strategy ?? null,
          cards: body.cards,
        })
        .select()
        .single());
    }
    if (error) throw error;
    return NextResponse.json({ deck: data });
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
