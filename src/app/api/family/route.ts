import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { cycleStart, MONTHLY_GRANT } from "@/lib/credits";
import { errorJson } from "@/lib/apiError";

// Family management. All writes go through here with the service role —
// the tables are read-only to clients by design, so a kid can't PATCH their
// own cap away.

const MAX_MEMBERS = 5;

/** The app's own origin, for building an invitation link. Behind Railway's
 *  proxy the request URL's host is the internal one, so the forwarded header
 *  wins when it's there. */
function originOf(req: Request): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

async function loadGroup(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data: mine } = await admin
    .from("family_members")
    .select("group_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (!mine) return null;
  const [{ data: group }, { data: members }] = await Promise.all([
    admin.from("family_groups").select("*").eq("id", mine.group_id).single(),
    admin.from("family_members").select("*").eq("group_id", mine.group_id).order("created_at"),
  ]);
  return { group, members: members ?? [], myRole: mine.role as string };
}

/** GET: my family — members, per-member usage this cycle, caps. */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const admin = createAdminClient();
    const fam = await loadGroup(admin, user.id);
    if (!fam?.group) {
      return NextResponse.json({
        group: null,
        canCreate: (profile?.plan ?? "free") === "family",
        plan: profile?.plan ?? "free",
      });
    }

    const ids = fam.members.map((m) => m.user_id as string);
    const { data: owner } = await admin
      .from("profiles")
      .select("created_at, billing_anchor")
      .eq("id", fam.group.owner_user)
      .single();
    const anchor =
      (owner?.billing_anchor as string | null) ?? (owner?.created_at as string) ?? new Date().toISOString();
    const since = cycleStart(anchor).toISOString();

    const [{ data: profiles }, { data: spends }] = await Promise.all([
      admin.from("profiles").select("id, email, display_name, trade_board_enabled").in("id", ids),
      admin
        .from("credit_ledger")
        .select("user_id, delta")
        .in("user_id", ids)
        .gte("created_at", since)
        .lt("delta", 0),
    ]);
    const profById = new Map((profiles ?? []).map((p) => [p.id as string, p]));
    const spentBy = new Map<string, number>();
    for (const s of spends ?? []) {
      spentBy.set(s.user_id as string, (spentBy.get(s.user_id as string) ?? 0) - (s.delta as number));
    }

    return NextResponse.json({
      group: {
        id: fam.group.id,
        ownerId: fam.group.owner_user,
        myRole: fam.myRole,
        amOwner: fam.group.owner_user === user.id,
        // Which row is you. The page needs it to know whose collection it
        // shouldn't offer to open — yours is one tab away already.
        meId: user.id,
        poolGrant: MONTHLY_GRANT.family,
        members: fam.members.map((m) => {
          const p = profById.get(m.user_id as string);
          return {
            userId: m.user_id,
            role: m.role,
            cap: m.credit_cap,
            isOwner: m.user_id === fam.group!.owner_user,
            name:
              ((p?.display_name as string | null) ?? "").trim() ||
              ((p?.email as string) ?? "").split("@")[0],
            email: (p?.email as string) ?? "",
            tradeBoardEnabled: (p?.trade_board_enabled as boolean | undefined) ?? true,
            spentThisCycle: spentBy.get(m.user_id as string) ?? 0,
          };
        }),
      },
      plan: profile?.plan ?? "free",
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return errorJson(err, "Request failed");
  }
}

/** POST: create my group, or invite an existing account into it.
 *  Body: { action: "create" } | { action: "invite", email, role? } */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const admin = createAdminClient();
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      email?: string;
      role?: string;
    };

    if (body.action === "create") {
      if ((profile?.plan ?? "free") !== "family") {
        return NextResponse.json(
          { error: "Creating a family needs the Family plan — upgrade first." },
          { status: 403 }
        );
      }
      const existing = await loadGroup(admin, user.id);
      if (existing) return NextResponse.json({ error: "You're already in a family." }, { status: 409 });
      const { data: group, error } = await admin
        .from("family_groups")
        .insert({ owner_user: user.id })
        .select("id")
        .single();
      if (error) throw error;
      await admin
        .from("family_members")
        .insert({ group_id: group.id, user_id: user.id, role: "parent" });
      return NextResponse.json({ ok: true });
    }

    // Invite: creates a request, never a membership.
    //
    // This used to insert straight into family_members on a typed email
    // address, so anyone who knew your address could put your account in
    // their group — and being in one is not cosmetic. A parent can cap your
    // monthly spending, switch your trade board off, and see your usage
    // itemised; your AI requests start drawing on their pool. Nobody should
    // get that over an account without the account's agreement.
    //
    // It also no longer requires the invitee to have signed up first, which
    // was a strange thing to ask of the person doing the inviting. The link
    // works either way: an existing account answers it in place, a new one
    // signs up and lands back on it.
    if (body.action === "invite") {
      const fam = await loadGroup(admin, user.id);
      if (!fam?.group || fam.myRole !== "parent") {
        return NextResponse.json({ error: "Only a parent can invite members." }, { status: 403 });
      }
      const email = (body.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return NextResponse.json({ error: "That doesn't look like an email address." }, { status: 400 });
      }
      if (email === (user.email ?? "").toLowerCase()) {
        return NextResponse.json({ error: "You're already in this family." }, { status: 400 });
      }

      // Seats are counted as members plus invitations already outstanding.
      // Counting only members would let five pending invites all land on a
      // family with one seat free.
      const { count: pending } = await admin
        .from("family_invites")
        .select("id", { count: "exact", head: true })
        .eq("group_id", fam.group.id)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString());
      if (fam.members.length + (pending ?? 0) >= MAX_MEMBERS) {
        return NextResponse.json(
          {
            error: `A family holds up to ${MAX_MEMBERS} profiles, counting invitations you haven't had answered yet.`,
          },
          { status: 409 }
        );
      }

      // If they already have an account and are already in a family, say so
      // now rather than after they've followed a link that can't work.
      const { data: target } = await admin
        .from("profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (target) {
        const { data: theirs } = await admin
          .from("family_members")
          .select("group_id")
          .eq("user_id", target.id)
          .maybeSingle();
        if (theirs) {
          return NextResponse.json(
            {
              error:
                theirs.group_id === fam.group.id
                  ? "They're already in your family."
                  : "That account already belongs to another family.",
            },
            { status: 409 }
          );
        }
      }

      const token = randomBytes(24).toString("base64url");
      const role = body.role === "parent" ? "parent" : "kid";
      const { error } = await admin.from("family_invites").insert({
        group_id: fam.group.id,
        invited_by: user.id,
        email,
        role,
        token,
      });
      if (error) {
        // The partial unique index: one live invitation per address.
        return NextResponse.json(
          { error: "You've already invited that address — resend or cancel that invitation." },
          { status: 409 }
        );
      }
      return NextResponse.json({
        ok: true,
        // The link IS the delivery mechanism. There is no outbound mail yet,
        // and returning a link the parent can send themselves is honest
        // about that rather than silently dropping the invitation into a
        // mail queue that doesn't exist.
        link: `${originOf(req)}/family/join/${token}`,
        hasAccount: !!target,
      });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return errorJson(err, "Request failed");
  }
}

/** PATCH: parent-only member settings.
 *  Body: { userId, cap?: number|null, tradeBoard?: boolean, role?: "parent"|"kid" } */
export async function PATCH(req: Request) {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const fam = await loadGroup(admin, user.id);
    if (!fam?.group || fam.myRole !== "parent") {
      return NextResponse.json({ error: "Only a parent can change member settings." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      userId?: string;
      cap?: number | null;
      tradeBoard?: boolean;
      role?: string;
    };
    const target = fam.members.find((m) => m.user_id === body.userId);
    if (!target) return NextResponse.json({ error: "Not a member of your family." }, { status: 404 });

    if (body.cap !== undefined) {
      const cap =
        body.cap == null ? null : Math.max(0, Math.min(10_000, Math.round(Number(body.cap))));
      if (cap !== null && !Number.isFinite(cap)) {
        return NextResponse.json({ error: "Cap must be a number of credits." }, { status: 400 });
      }
      await admin
        .from("family_members")
        .update({ credit_cap: cap })
        .eq("group_id", fam.group.id)
        .eq("user_id", body.userId);
    }
    if (body.tradeBoard !== undefined) {
      await admin
        .from("profiles")
        .update({ trade_board_enabled: body.tradeBoard === true })
        .eq("id", body.userId);
    }
    if (body.role === "parent" || body.role === "kid") {
      if (body.userId === fam.group.owner_user && body.role !== "parent") {
        return NextResponse.json({ error: "The owner stays a parent." }, { status: 400 });
      }
      await admin
        .from("family_members")
        .update({ role: body.role })
        .eq("group_id", fam.group.id)
        .eq("user_id", body.userId);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return errorJson(err, "Request failed");
  }
}

/** DELETE: remove a member (parents), or leave (anyone but the owner). */
export async function DELETE(req: Request) {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const fam = await loadGroup(admin, user.id);
    if (!fam?.group) return NextResponse.json({ error: "You're not in a family." }, { status: 404 });
    const { userId } = (await req.json().catch(() => ({}))) as { userId?: string };
    const targetId = userId ?? user.id;

    if (targetId === fam.group.owner_user) {
      return NextResponse.json(
        { error: "The owner can't be removed — cancel the Family plan instead." },
        { status: 400 }
      );
    }
    if (targetId !== user.id && fam.myRole !== "parent") {
      return NextResponse.json({ error: "Only a parent can remove members." }, { status: 403 });
    }
    await admin
      .from("family_members")
      .delete()
      .eq("group_id", fam.group.id)
      .eq("user_id", targetId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return errorJson(err, "Request failed");
  }
}
