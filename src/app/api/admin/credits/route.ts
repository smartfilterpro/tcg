import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

// Granting credits to an account by hand: support goodwill, a comped
// mistake, a beta tester, making someone whole after an outage.
//
// This mints value out of nothing, so it is the one admin action that has to
// leave a trail. The ledger row alone doesn't: an untagged +500 looks
// identical whether it was goodwill, a refund, or a slip of the keyboard.
// Every grant records who did it and why, in a table no client can read.

/** Sane ceiling per action. Not a policy about generosity — a guard against
 *  a typo turning 50 into 50000, which the ledger has no way to undo except
 *  by another manual entry. */
const MAX_PER_GRANT = 5000;

export async function POST(req: Request) {
  try {
    const { user: adminUser } = await requireAdmin();
    const admin = createAdminClient();
    const body = (await req.json().catch(() => ({}))) as {
      userId?: string;
      email?: string;
      delta?: number;
      note?: string;
    };

    const note = (body.note ?? "").trim();
    if (!note) {
      // Required, deliberately. A reason written six months later is a guess;
      // written now it is a record, and it costs five seconds.
      return NextResponse.json(
        { error: "Say what this is for — it goes in the audit trail." },
        { status: 400 }
      );
    }

    const delta = Math.round(Number(body.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      return NextResponse.json({ error: "How many credits?" }, { status: 400 });
    }
    if (Math.abs(delta) > MAX_PER_GRANT) {
      return NextResponse.json(
        { error: `Keep a single adjustment to ${MAX_PER_GRANT.toLocaleString()} credits or fewer.` },
        { status: 400 }
      );
    }

    // Find them by id or email — an admin looking at a support thread has an
    // email address, not a uuid.
    let targetId = (body.userId ?? "").trim();
    if (!targetId) {
      const email = (body.email ?? "").trim().toLowerCase();
      if (!email) return NextResponse.json({ error: "Which account?" }, { status: 400 });
      const { data } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (!data) return NextResponse.json({ error: "No account with that email." }, { status: 404 });
      targetId = data.id as string;
    }

    const { data: ledger, error } = await admin
      .from("credit_ledger")
      .insert({
        user_id: targetId,
        delta,
        // Its own reason, so it shows up separately in the user's own
        // breakdown rather than being mistaken for a purchase they made.
        reason: delta > 0 ? "admin_grant" : "admin_adjustment",
        // No ref_id: these are deliberate one-offs, and the idempotency index
        // would silently swallow a second, genuinely intended grant.
        ref_id: null,
      })
      .select("id")
      .single();
    if (error) throw error;

    const { error: auditError } = await admin.from("credit_grant_audit").insert({
      ledger_id: ledger.id,
      target_user: targetId,
      granted_by: adminUser.id,
      delta,
      note,
    });
    if (auditError) {
      // Loud, and worth being loud about: the credits are already granted, so
      // this is a real grant with no record of who made it.
      console.error(
        `ADMIN: credit grant of ${delta} to ${targetId} by ${adminUser.id} was NOT audited: ` +
          `${auditError.message}. Run migration 032 if the table is missing.`
      );
    }

    // Fresh balance back, so the panel can show the result rather than
    // claiming success and leaving the number stale.
    const { data: rows } = await admin
      .from("credit_ledger")
      .select("delta")
      .eq("user_id", targetId);
    const balance = (rows ?? []).reduce((s, r) => s + (r.delta as number), 0);

    return NextResponse.json({
      ok: true,
      balance,
      audited: !auditError,
      userId: targetId,
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("admin credit grant error", err);
    return NextResponse.json({ error: "Couldn't apply that adjustment" }, { status: 500 });
  }
}

/** GET ?userId= — recent manual adjustments, for the panel. */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const userId = new URL(req.url).searchParams.get("userId");

    let q = admin
      .from("credit_grant_audit")
      .select("id, target_user, granted_by, delta, note, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (userId) q = q.eq("target_user", userId);
    const { data, error } = await q;
    if (error) return NextResponse.json({ grants: [], migrated: false });

    const ids = [
      ...new Set((data ?? []).flatMap((g) => [g.target_user as string, g.granted_by as string])),
    ];
    const { data: profiles } = ids.length
      ? await admin.from("profiles").select("id, email").in("id", ids)
      : { data: [] };
    const emailOf = new Map((profiles ?? []).map((p) => [p.id as string, p.email as string]));

    return NextResponse.json({
      migrated: true,
      grants: (data ?? []).map((g) => ({
        id: g.id,
        delta: g.delta,
        note: g.note,
        at: g.created_at,
        target: emailOf.get(g.target_user as string) ?? g.target_user,
        by: emailOf.get(g.granted_by as string) ?? g.granted_by,
      })),
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ grants: [], migrated: false });
  }
}
