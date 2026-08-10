import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { errorJson } from "@/lib/apiError";

interface Params {
  params: Promise<{ id: string }>;
}

/** How far back the card sheet looks. Long enough to show a season's drift,
 *  short enough that the series stays readable at sparkline size. */
const WINDOW_DAYS = 90;

/** GET: what this card has been worth, newest last.
 *
 *  Sparse by design — migration 062's trigger only records a day when the
 *  price actually moved, so a steady card is one point and a volatile one is
 *  many. Read it as a step function: the price held whatever the last point
 *  said until the next one. */
export async function GET(_req: Request, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;
    const supabase = await createClient();

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - WINDOW_DAYS);

    const { data, error } = await supabase
      .from("card_price_history")
      .select("on_date, market_price")
      .eq("card_id", id)
      .gte("on_date", since.toISOString().slice(0, 10))
      .order("on_date");
    if (error) throw error;

    const points = (data ?? [])
      .filter((r) => r.market_price != null)
      .map((r) => ({ date: r.on_date as string, price: Number(r.market_price) }));

    return NextResponse.json({ points });
  } catch (err) {
    // A missing table (migration 062 not run) is not worth an error banner
    // over a card sheet that is otherwise fine. An empty series is the honest
    // answer either way — "nothing recorded yet" — and the panel that reads
    // this hides itself when there's nothing to draw.
    if (err instanceof Error && err.name === "AuthError") {
      return errorJson(err, "Sign in to see price history.");
    }
    console.error("price history:", err);
    return NextResponse.json({ points: [] });
  }
}
