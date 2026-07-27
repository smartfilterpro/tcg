import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

export interface OfferLine {
  label: string;
  qty: number;
  value: number | null;
  image: string | null;
}

function sanitizeLines(input: unknown, cap = 30): OfferLine[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((l) => l && typeof l.label === "string" && Number.isInteger(l.qty) && l.qty > 0)
    .slice(0, cap)
    .map((l) => ({
      label: String(l.label).slice(0, 300),
      qty: Math.min(99, l.qty as number),
      value: typeof l.value === "number" && Number.isFinite(l.value) ? l.value : null,
      image: typeof l.image === "string" ? l.image.slice(0, 500) : null,
    }));
}

/** GET: my trade offers, both directions, newest first. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data: offers, error } = await supabase
      .from("trade_offers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      if (/trade_offers/i.test(error.message ?? "")) {
        return NextResponse.json({ migrated: false, offers: [], myId: user.id });
      }
      throw error;
    }
    const { data: profiles } = await supabase.from("profiles").select("*");
    const nameById = new Map(
      (profiles ?? []).map((p) => [p.id as string, (p.display_name || p.email) as string])
    );
    const result = (offers ?? []).map((o) => ({
      id: o.id,
      direction: o.from_user === user.id ? "outgoing" : "incoming",
      otherName:
        o.from_user === user.id
          ? nameById.get(o.to_user) ?? "A member"
          : nameById.get(o.from_user) ?? "A member",
      give: sanitizeLines(o.give),
      get: sanitizeLines(o.get),
      message: o.message,
      status: o.status,
      created_at: o.created_at,
    }));
    return NextResponse.json({ migrated: true, offers: result, myId: user.id });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: send a trade request.
 *  Body: { toUserId, give: OfferLine[], get: OfferLine[], message? } */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json()) as {
      toUserId?: string;
      give?: unknown;
      get?: unknown;
      message?: string;
    };
    const give = sanitizeLines(body.give);
    const get = sanitizeLines(body.get);
    if (!body.toUserId || body.toUserId === user.id) {
      return NextResponse.json({ error: "Pick a friend to trade with." }, { status: 400 });
    }
    if (give.length === 0 && get.length === 0) {
      return NextResponse.json(
        { error: "Add at least one card to the trade first." },
        { status: 400 }
      );
    }
    const supabase = await createClient();
    const { data: recipient } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", body.toUserId)
      .maybeSingle();
    if (!recipient) {
      return NextResponse.json({ error: "That member no longer exists." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("trade_offers")
      .insert({
        from_user: user.id,
        to_user: body.toUserId,
        give,
        get,
        message: body.message?.trim().slice(0, 1000) || null,
      })
      .select()
      .single();
    if (error) {
      if (/trade_offers/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Trade requests aren't set up yet — run supabase/migrations/013_trade_offers.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ offer: data });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("trade offers error", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
