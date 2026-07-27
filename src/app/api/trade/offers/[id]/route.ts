import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: respond to a trade request. Body: { status }
 *  Recipient may accept/decline a pending offer; sender may withdraw it. */
export async function PATCH(req: Request, { params }: Params) {
  try {
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
