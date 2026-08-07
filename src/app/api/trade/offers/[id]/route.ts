import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { tradingOff, TRADING_OFF_ERROR } from "@/lib/tradeBoard";
import { errorJson } from "@/lib/apiError";

type Params = { params: Promise<{ id: string }> };

/** DELETE: clear a finished trade request (both sides lose it — RLS only
 *  allows this on non-pending offers involving the caller). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;
    const supabase = await createClient();
    // .select() so a zero-row delete (blocked by RLS — e.g. migration 014
    // not run, or a pending offer) is a visible error, not a silent no-op.
    const { data, error } = await supabase
      .from("trade_offers")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json(
        {
          error:
            "Nothing was cleared. Pending requests can't be cleared — and if this trade is finished, the admin needs to run supabase/migrations/014_trade_cleanup.sql.",
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}

/** PATCH: respond to a trade request. Body: { status }
 *  Recipient may accept/decline a pending offer; sender may withdraw it. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    // Trading is paused product-wide (lib/features). Writes stop here;
    // reads and admin removal still work, so nothing is stranded.
    if (tradingOff()) {
      return NextResponse.json({ error: TRADING_OFF_ERROR }, { status: 403 });
    }
    const { user } = await requireUser();
    const { id } = await params;
    const { status } = (await req.json()) as { status?: string };
    if (!["accepted", "declined", "withdrawn"].includes(status ?? "")) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const supabase = await createClient();
    const { data: offer } = await supabase
      .from("trade_offers")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!offer) {
      return NextResponse.json({ error: "Trade request not found." }, { status: 404 });
    }
    if (offer.status !== "pending") {
      return NextResponse.json(
        { error: "This trade request was already resolved." },
        { status: 409 }
      );
    }
    const isSender = offer.from_user === user.id;
    const isRecipient = offer.to_user === user.id;
    const allowed =
      (status === "withdrawn" && isSender) ||
      ((status === "accepted" || status === "declined") && isRecipient);
    if (!allowed) {
      return NextResponse.json({ error: "Not your call on this one." }, { status: 403 });
    }
    const { error } = await supabase
      .from("trade_offers")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
