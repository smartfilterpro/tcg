import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { tradingOff, TRADING_OFF_ERROR } from "@/lib/tradeBoard";

type Params = { params: Promise<{ id: string }> };

/** POST: message the other side of a trade request. Body: { body }
 *  RLS restricts this to the two participants; we additionally block
 *  messaging on declined/withdrawn trades (nothing left to discuss). */
export async function POST(req: Request, { params }: Params) {
  try {
    // Trading is paused product-wide (lib/features). Writes stop here;
    // reads and admin removal still work, so nothing is stranded.
    if (tradingOff()) {
      return NextResponse.json({ error: TRADING_OFF_ERROR }, { status: 403 });
    }
    const { user } = await requireUser();
    const { id } = await params;
    const { body } = (await req.json()) as { body?: string };
    const text = body?.trim() ?? "";
    if (!text || text.length > 1000) {
      return NextResponse.json({ error: "Write a message (max 1000 chars)." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data: offer } = await supabase
      .from("trade_offers")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (!offer) {
      return NextResponse.json({ error: "Trade request not found." }, { status: 404 });
    }
    if (offer.status === "declined" || offer.status === "withdrawn") {
      return NextResponse.json(
        { error: "This trade was closed — send a new request to keep talking." },
        { status: 409 }
      );
    }
    const { data, error } = await supabase
      .from("trade_offer_messages")
      .insert({ offer_id: id, user_id: user.id, body: text })
      .select()
      .single();
    if (error) {
      if (/trade_offer_messages/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Trade messages aren't set up yet — run supabase/migrations/015_trade_messages.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    // Bump the offer so active conversations sort to the top
    await supabase
      .from("trade_offers")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ message: data });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
