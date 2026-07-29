import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { cycleStart, MONTHLY_GRANT } from "@/lib/credits";

// Family management. All writes go through here with the service role —
// the tables are read-only to clients by design, so a kid can't PATCH their
// own cap away.

const MAX_MEMBERS = 5;

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
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
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

    if (body.action === "invite") {
      const fam = await loadGroup(admin, user.id);
      if (!fam?.group || fam.myRole !== "parent") {
        return NextResponse.json({ error: "Only a parent can add members." }, { status: 403 });
      }
      if (fam.members.length >= MAX_MEMBERS) {
        return NextResponse.json({ error: `A family holds up to ${MAX_MEMBERS} profiles.` }, { status: 409 });
      }
      const email = (body.email ?? "").trim().toLowerCase();
      const { data: target } = await admin
        .from("profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (!target) {
        return NextResponse.json(
          {
            error:
              "No account with that email. Have them sign up first (it's free), then add them here.",
          },
          { status: 404 }
        );
      }
      const role = body.role === "parent" ? "parent" : "kid";
      const { error } = await admin
        .from("family_members")
        .insert({ group_id: fam.group.id, user_id: target.id, role });
      if (error) {
        // unique(user_id): already in a family — theirs or yours.
        return NextResponse.json(
          { error: "That account is already part of a family." },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
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
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
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
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
  }
}
