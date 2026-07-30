import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Answering a family invitation, and listing the ones that concern you.
//
// Membership is written here and nowhere else. Everything the parent's side
// can do is create a pending row; this is the only path that turns one into
// a seat in a family, and it runs as the person being invited.

const MAX_MEMBERS = 5;

interface InviteRow {
  id: string;
  group_id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  expires_at: string;
  created_at: string;
  invited_by: string;
}

/** GET: invitations addressed to me (pending), and the ones my family has
 *  sent that are still outstanding. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const email = (user.email ?? "").toLowerCase();
    const now = new Date().toISOString();

    const { data: incoming } = await admin
      .from("family_invites")
      .select("id, group_id, role, token, expires_at, invited_by")
      .eq("email", email)
      .eq("status", "pending")
      .gt("expires_at", now);

    // Name whoever is asking. An invitation from an address you don't
    // recognise should be declinable on that basis alone.
    const inviterIds = [...new Set((incoming ?? []).map((i) => i.invited_by as string))];
    const { data: inviters } = inviterIds.length
      ? await admin.from("profiles").select("id, email, display_name").in("id", inviterIds)
      : { data: [] };
    const nameOf = new Map(
      (inviters ?? []).map((p) => [
        p.id as string,
        ((p.display_name as string | null) ?? "").trim() || ((p.email as string) ?? "").split("@")[0],
      ])
    );

    // My family's outstanding invitations, if I'm a parent in one.
    const { data: mine } = await admin
      .from("family_members")
      .select("group_id, role")
      .eq("user_id", user.id)
      .maybeSingle();
    const { data: sent } =
      mine && mine.role === "parent"
        ? await admin
            .from("family_invites")
            .select("id, email, role, token, expires_at, created_at")
            .eq("group_id", mine.group_id)
            .eq("status", "pending")
            .gt("expires_at", now)
            .order("created_at")
        : { data: [] };

    return NextResponse.json({
      incoming: (incoming ?? []).map((i) => ({
        id: i.id,
        role: i.role,
        token: i.token,
        expiresAt: i.expires_at,
        from: nameOf.get(i.invited_by as string) ?? "Someone",
      })),
      sent: sent ?? [],
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}

/** POST { token | id, accept } — answer an invitation addressed to me. */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const body = (await req.json().catch(() => ({}))) as {
      token?: string;
      id?: string;
      accept?: boolean;
    };

    const query = admin
      .from("family_invites")
      .select("id, group_id, email, role, token, status, expires_at, created_at, invited_by")
      .eq("status", "pending");
    const { data: invite } = body.token
      ? await query.eq("token", body.token).maybeSingle()
      : await query.eq("id", body.id ?? "").maybeSingle();

    if (!invite) {
      return NextResponse.json(
        { error: "That invitation has expired or has already been answered." },
        { status: 404 }
      );
    }
    const row = invite as InviteRow;

    if (new Date(row.expires_at) <= new Date()) {
      return NextResponse.json({ error: "That invitation has expired." }, { status: 410 });
    }

    // The invitation is for an address, and only that address can redeem it.
    // Without this, forwarding the link would hand the seat to whoever
    // opened it first.
    if (row.email.toLowerCase() !== (user.email ?? "").toLowerCase()) {
      return NextResponse.json(
        {
          error: `That invitation was sent to ${row.email}. Sign in with that account to accept it.`,
        },
        { status: 403 }
      );
    }

    if (body.accept !== true) {
      await admin
        .from("family_invites")
        .update({ status: "declined", responded_at: new Date().toISOString() })
        .eq("id", row.id);
      return NextResponse.json({ ok: true, joined: false });
    }

    // Re-checked at acceptance, not just at invitation: an invite may have
    // sat for two weeks while the family filled up.
    const { count } = await admin
      .from("family_members")
      .select("user_id", { count: "exact", head: true })
      .eq("group_id", row.group_id);
    if ((count ?? 0) >= MAX_MEMBERS) {
      return NextResponse.json(
        { error: "That family is full — ask them to free up a place." },
        { status: 409 }
      );
    }

    const { error } = await admin
      .from("family_members")
      .insert({ group_id: row.group_id, user_id: user.id, role: row.role });
    if (error) {
      // unique(user_id): joined a family between the invite and the answer.
      return NextResponse.json(
        { error: "You're already in a family — leave that one first." },
        { status: 409 }
      );
    }
    await admin
      .from("family_invites")
      .update({ status: "accepted", responded_at: new Date().toISOString() })
      .eq("id", row.id);

    return NextResponse.json({ ok: true, joined: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}

/** DELETE { id } — a parent withdrawing an invitation they sent. */
export async function DELETE(req: Request) {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const { id } = (await req.json().catch(() => ({}))) as { id?: string };

    const { data: mine } = await admin
      .from("family_members")
      .select("group_id, role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!mine || mine.role !== "parent") {
      return NextResponse.json({ error: "Only a parent can cancel invitations." }, { status: 403 });
    }
    await admin
      .from("family_invites")
      .update({ status: "revoked", responded_at: new Date().toISOString() })
      .eq("id", id ?? "")
      .eq("group_id", mine.group_id)
      .eq("status", "pending");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}
