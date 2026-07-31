import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { isFreeTier, FREE_DECK_LIMIT } from "@/lib/credits";
import type { DeckCardEntry, DeckSuggestion } from "@/lib/types";

export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("decks")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ decks: data ?? [] });
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
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
