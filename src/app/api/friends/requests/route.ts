import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

const MIGRATION_MSG =
  "Pokémon Pals needs a one-time database update — run supabase/migrations/020_pals.sql in the Supabase SQL Editor.";

function isMissingPals(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? "";
  return /friendships|friend_messages/.test(msg) && /(does not exist|not find|schema cache)/i.test(msg);
}

interface PalMessage {
  id: string;
  mine: boolean;
  authorName: string;
  body: string;
  created_at: string;
}

/** GET: everything the Pals UI needs — accepted pals (with message threads),
 *  incoming/outgoing requests, and members you could still ask. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();

    const [{ data: profiles }, friendshipsRes] = await Promise.all([
      supabase.from("profiles").select("id, email, display_name"),
      supabase
        .from("friendships")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(200),
    ]);
    if (friendshipsRes.error) {
      if (isMissingPals(friendshipsRes.error)) {
        return NextResponse.json({ migrated: false, pals: [], incoming: [], outgoing: [], candidates: [] });
      }
      throw friendshipsRes.error;
    }

    const nameOf = new Map<string, string>();
    for (const p of profiles ?? []) {
      nameOf.set(
        p.id as string,
        ((p.display_name as string | null)?.trim() || (p.email as string).split("@")[0]) as string
      );
    }
    const rows = friendshipsRes.data ?? [];
    const otherId = (r: { requester: string; addressee: string }) =>
      r.requester === user.id ? r.addressee : r.requester;

    const accepted = rows.filter((r) => r.status === "accepted");
    const messagesByFriendship = new Map<string, PalMessage[]>();
    if (accepted.length > 0) {
      const { data: msgs } = await supabase
        .from("friend_messages")
        .select("id, friendship_id, sender, body, created_at")
        .in("friendship_id", accepted.map((r) => r.id))
        .order("created_at", { ascending: true })
        .limit(500);
      for (const m of msgs ?? []) {
        const list = messagesByFriendship.get(m.friendship_id as string) ?? [];
        list.push({
          id: m.id as string,
          mine: m.sender === user.id,
          authorName: nameOf.get(m.sender as string) ?? "Trainer",
          body: m.body as string,
          created_at: m.created_at as string,
        });
        messagesByFriendship.set(m.friendship_id as string, list);
      }
    }

    const pals = accepted.map((r) => ({
      id: r.id as string,
      userId: otherId(r),
      name: nameOf.get(otherId(r)) ?? "Trainer",
      since: r.updated_at as string,
      messages: (messagesByFriendship.get(r.id as string) ?? []).slice(-50),
    }));
    const incoming = rows
      .filter((r) => r.status === "pending" && r.addressee === user.id)
      .map((r) => ({ id: r.id as string, userId: r.requester as string, name: nameOf.get(r.requester as string) ?? "Trainer" }));
    const outgoing = rows
      .filter((r) => r.status === "pending" && r.requester === user.id)
      .map((r) => ({ id: r.id as string, userId: r.addressee as string, name: nameOf.get(r.addressee as string) ?? "Trainer" }));

    const involved = new Set(rows.filter((r) => r.status !== "declined").map(otherId));
    const candidates = (profiles ?? [])
      .filter((p) => p.id !== user.id && !involved.has(p.id as string))
      .map((p) => ({ userId: p.id as string, name: nameOf.get(p.id as string) ?? "Trainer" }));

    return NextResponse.json({ migrated: true, pals, incoming, outgoing, candidates });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: send a pal request. Body: { toUserId } */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { toUserId } = (await req.json()) as { toUserId?: string };
    if (!toUserId || typeof toUserId !== "string" || toUserId === user.id) {
      return NextResponse.json({ error: "Pick a member to send a request to." }, { status: 400 });
    }
    const supabase = await createClient();

    const { data: existing, error: exErr } = await supabase
      .from("friendships")
      .select("id, status, requester")
      .or(
        `and(requester.eq.${user.id},addressee.eq.${toUserId}),and(requester.eq.${toUserId},addressee.eq.${user.id})`
      )
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) {
      if (existing.status === "accepted") {
        return NextResponse.json({ error: "You're already pals!" }, { status: 400 });
      }
      if (existing.status === "pending") {
        return NextResponse.json(
          { error: existing.requester === user.id ? "Request already sent." : "They already asked YOU — check your incoming requests." },
          { status: 400 }
        );
      }
      // Declined earlier — re-open as a fresh request from me.
      const { data: updated, error } = await supabase
        .from("friendships")
        .update({ requester: user.id, addressee: toUserId, status: "pending", updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select("id");
      if (error) throw error;
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: "Couldn't re-send the request." }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }

    const { error } = await supabase
      .from("friendships")
      .insert({ requester: user.id, addressee: toUserId });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH: answer a request. Body: { id, action: "accept" | "decline" } */
export async function PATCH(req: Request) {
  try {
    const { user } = await requireUser();
    const { id, action } = (await req.json()) as { id?: string; action?: string };
    if (!id || (action !== "accept" && action !== "decline")) {
      return NextResponse.json({ error: "Missing request or action." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("friendships")
      .update({ status: action === "accept" ? "accepted" : "declined", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("addressee", user.id)
      .eq("status", "pending")
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "That request isn't waiting on you." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: cancel an outgoing request, or unfriend. Body: { id } */
export async function DELETE(req: Request) {
  try {
    await requireUser();
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.from("friendships").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Nothing was removed." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (isMissingPals(err)) {
    return NextResponse.json({ error: MIGRATION_MSG }, { status: 400 });
  }
  console.error("friends/requests error", err);
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : "Request failed";
  return NextResponse.json({ error: message }, { status: 500 });
}
