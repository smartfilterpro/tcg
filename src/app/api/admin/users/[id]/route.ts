import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: update a member's AI budget and/or suspension.
 *  Body: { aiBudgetUsd?, suspended? } */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user } = await requireAdmin();
    const { id } = await params;
    const { aiBudgetUsd, suspended } = (await req.json()) as {
      aiBudgetUsd?: number;
      suspended?: boolean;
    };

    const patch: Record<string, unknown> = {};
    if (aiBudgetUsd !== undefined) {
      if (
        typeof aiBudgetUsd !== "number" ||
        !Number.isFinite(aiBudgetUsd) ||
        aiBudgetUsd < 0 ||
        aiBudgetUsd > 10000
      ) {
        return NextResponse.json(
          { error: "Budget must be a number between 0 and 10000." },
          { status: 400 }
        );
      }
      patch.ai_budget_usd = aiBudgetUsd;
    }
    if (suspended !== undefined) {
      if (typeof suspended !== "boolean") {
        return NextResponse.json({ error: "Invalid suspended flag" }, { status: 400 });
      }
      if (id === user.id) {
        return NextResponse.json({ error: "You can't suspend yourself." }, { status: 400 });
      }
      patch.suspended = suspended;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const admin = createAdminClient();
    const { error } = await admin.from("profiles").update(patch).eq("id", id);
    if (error) {
      if (/ai_budget_usd|suspended/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "This needs a database update — run supabase/migrations/011_budget_suspend.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
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

/** DELETE: remove a user entirely (admin only, cannot delete yourself). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { user } = await requireAdmin();
    const { id } = await params;
    if (id === user.id) {
      return NextResponse.json({ error: "You can't delete yourself." }, { status: 400 });
    }
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
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
