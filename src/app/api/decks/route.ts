import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import type { DeckCardEntry } from "@/lib/types";

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
    const { user } = await requireUser();
    const body = (await req.json()) as {
      name?: string;
      strategy?: string;
      cards?: DeckCardEntry[];
    };
    if (!body.name?.trim() || !Array.isArray(body.cards) || body.cards.length === 0) {
      return NextResponse.json({ error: "Name and cards are required" }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("decks")
      .insert({
        user_id: user.id,
        name: body.name.trim(),
        strategy: body.strategy ?? null,
        cards: body.cards,
      })
      .select()
      .single();
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
