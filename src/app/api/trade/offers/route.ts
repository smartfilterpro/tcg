import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { numberKey } from "@/lib/pokemontcg";
import type { SupabaseClient } from "@supabase/supabase-js";

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

/** Offers created before images were snapshotted have no picture — resolve
 *  them from the shared cards table by the "Name #number (…)" label. */
async function backfillImages(supabase: SupabaseClient, lines: OfferLine[]): Promise<void> {
  const cache = new Map<string, string | null>();
  let lookups = 0;
  for (const line of lines) {
    if (line.image || lookups >= 30) continue;
    if (cache.has(line.label)) {
      line.image = cache.get(line.label) ?? null;
      continue;
    }
    const m = /^(.+?) #(\S+) \(/.exec(line.label);
    if (!m) continue;
    lookups++;
    try {
      const { data } = await supabase
        .from("cards")
        .select("number, image_small")
        .ilike("name", m[1].replace(/[%_]/g, ""))
        .limit(10);
      const hit =
        (data ?? []).find((c) => numberKey(c.number) === numberKey(m[2])) ?? (data ?? [])[0];
      const img = (hit?.image_small as string | null) ?? null;
      cache.set(line.label, img);
      line.image = img;
    } catch {
      cache.set(line.label, null);
    }
  }
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
    await backfillImages(
      supabase,
      result.flatMap((o) => [...o.give, ...o.get])
    );

    // Per-offer message threads (best-effort — table exists after migration 015)
    const messagesByOffer = new Map<
      string,
      Array<{ id: string; authorName: string; mine: boolean; body: string; created_at: string }>
    >();
    if (result.length > 0) {
      const { data: msgs } = await supabase
        .from("trade_offer_messages")
        .select("*")
        .in("offer_id", result.map((o) => o.id))
        .order("created_at")
        .limit(2000);
      for (const m of msgs ?? []) {
        const list = messagesByOffer.get(m.offer_id) ?? [];
        list.push({
          id: m.id,
          authorName: nameById.get(m.user_id) ?? "A member",
          mine: m.user_id === user.id,
          body: m.body,
          created_at: m.created_at,
        });
        messagesByOffer.set(m.offer_id, list);
      }
    }
    const withMessages = result.map((o) => ({
      ...o,
      messages: messagesByOffer.get(o.id) ?? [],
    }));

    return NextResponse.json({ migrated: true, offers: withMessages, myId: user.id });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: clear ALL my finished trade requests (RLS limits the delete to
 *  non-pending offers the caller participates in). */
export async function DELETE() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("trade_offers")
      .delete()
      .neq("status", "pending")
      .or(`from_user.eq.${user.id},to_user.eq.${user.id}`)
      .select("id");
    if (error) throw error;
    return NextResponse.json({ ok: true, cleared: data?.length ?? 0 });
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
