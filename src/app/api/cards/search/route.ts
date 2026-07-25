import { NextResponse } from "next/server";
import { searchCards } from "@/lib/pokemontcg";
import { requireUser, AuthError } from "@/lib/auth";

/** Live card search against pokemontcg.io — used by the "fix this card" picker. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    const number = url.searchParams.get("number")?.trim() || undefined;
    if (!q) return NextResponse.json({ cards: [] });
    const cards = await searchCards({ name: q, number, pageSize: 16 });
    return NextResponse.json({ cards });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
