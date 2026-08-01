import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireModerator, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: update a member's AI budget and/or suspension.
 *  Body: { aiBudgetUsd?, suspended? } */
export async function PATCH(req: Request, { params }: Params) {
  try {
    // Moderators reach this route, but only for the moderation fields. The
    // money and irreversible ones are checked field by field below rather
    // than by widening the gate — a new field added later defaults to
    // being admin-only, which is the safe direction to be wrong in.
    const { user, isAdmin } = await requireModerator();
    const { id } = await params;
    const { aiBudgetUsd, suspended, resetDisplayName, canShareDecks, canPostTrades, role } =
      (await req.json()) as {
        aiBudgetUsd?: number;
        suspended?: boolean;
        /** Wipe an inappropriate display name; the member falls back to
         *  their email prefix everywhere until they pick a new one (which
         *  goes through the AI name screen like anyone's). */
        resetDisplayName?: boolean;
        canShareDecks?: boolean;
        canPostTrades?: boolean;
        /** Promote to admin or demote to member. Never your own row — an
         *  admin who demotes themselves locks everyone out of the tools. */
        role?: string;
      };

    const patch: Record<string, unknown> = {};
    // Roles and AI budgets are admin work: one hands out power, the other
    // spends money.
    if (!isAdmin && (role !== undefined || aiBudgetUsd !== undefined)) {
      return NextResponse.json(
        { error: "Only an admin can change roles or AI budgets." },
        { status: 403 }
      );
    }
    if (role !== undefined) {
      if (role !== "admin" && role !== "moderator" && role !== "member") {
        return NextResponse.json(
          { error: "Role must be 'admin', 'moderator' or 'member'." },
          { status: 400 }
        );
      }
      if (id === user.id) {
        return NextResponse.json({ error: "You can't change your own role." }, { status: 400 });
      }
      patch.role = role;
    }
    if (resetDisplayName === true) patch.display_name = null;
    if (canShareDecks !== undefined) {
      if (typeof canShareDecks !== "boolean") {
        return NextResponse.json({ error: "Invalid canShareDecks flag" }, { status: 400 });
      }
      patch.can_share_decks = canShareDecks;
    }
    if (canPostTrades !== undefined) {
      if (typeof canPostTrades !== "boolean") {
        return NextResponse.json({ error: "Invalid canPostTrades flag" }, { status: 400 });
      }
      patch.can_post_trades = canPostTrades;
    }
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
      if (/can_share_decks|can_post_trades/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Moderation switches need a database update — run supabase/migrations/038_moderation.sql first." },
          { status: 400 }
        );
      }
      if (/ai_budget_usd|suspended/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "This needs a database update — run supabase/migrations/011_budget_suspend.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }

    // Turning sharing off also takes down what's already up — the switch
    // would be theatre if the offending decks stayed on the Friends page.
    if (canShareDecks === false) {
      await admin.from("decks").update({ shared: false }).eq("user_id", id).then(() => {});
      const { data: theirDecks } = await admin.from("decks").select("id").eq("user_id", id);
      const ids = (theirDecks ?? []).map((d) => d.id as string);
      if (ids.length > 0) {
        await admin.from("deck_shares").delete().in("deck_id", ids).then(() => {});
      }
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
