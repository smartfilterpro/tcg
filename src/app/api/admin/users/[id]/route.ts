import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireModerator, AuthError } from "@/lib/auth";
import { errorJson } from "@/lib/apiError";

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
    const { aiBudgetUsd, suspended, resetDisplayName, canShareDecks, canPostTrades, role, plan } =
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
        /** Comp a plan without Stripe — the operator's own account, or
         *  making good on a checkout that went wrong. */
        plan?: string;
      };

    const patch: Record<string, unknown> = {};
    // Roles, AI budgets and plans are admin work: one hands out power, the
    // other two spend money. Unlike role, a plan MAY be set on your own
    // account — putting the operator's own login on Family is the reason
    // this exists.
    if (!isAdmin && (role !== undefined || aiBudgetUsd !== undefined || plan !== undefined)) {
      return NextResponse.json(
        { error: "Only an admin can change roles, AI budgets or plans." },
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
    if (plan !== undefined) {
      // Comping a plan by hand.
      //
      // Until now `plan` was written by exactly one thing — the Stripe
      // webhook — which is correct for customers and leaves no way to put
      // the operator's own account on Family, or to make good on a botched
      // checkout without asking someone to pay twice.
      //
      // Refused when Stripe is already the source of truth for this person.
      // Setting it by hand there would desync the two: Stripe keeps billing
      // on its own schedule and the next subscription event overwrites
      // whatever was typed here, so the change would appear to work and
      // then quietly undo itself.
      if (!["free", "pro", "family"].includes(plan as string)) {
        return NextResponse.json({ error: "Plan must be free, pro or family." }, { status: 400 });
      }
      const { data: target } = await createAdminClient()
        .from("profiles")
        .select("stripe_subscription")
        .eq("id", id)
        .maybeSingle();
      if ((target as { stripe_subscription?: string | null } | null)?.stripe_subscription) {
        return NextResponse.json(
          {
            error:
              "That account has a live subscription — change the plan in Stripe, or cancel it " +
              "there first. Setting it here would be overwritten by the next billing event.",
          },
          { status: 400 }
        );
      }
      patch.plan = plan;
      // Given, not sold. Revenue is derived from grant rows mapped back to a
      // plan price, so an unmarked comp would report income that never
      // arrived — and the operator's own Family plan would be the biggest
      // imaginary customer on the chart.
      patch.plan_comped = plan !== "free";
      // A comped plan has no billing period, so grants anchor to signup and
      // nothing expires it. Clearing the expiry matters: a stale one from an
      // old subscription would end the comp on a date nobody chose.
      patch.plan_expires_at = null;
      console.warn(`admin: ${user.id} set plan=${plan} on ${id}`);
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
    return errorJson(err, "Request failed");
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
    return errorJson(err, "Request failed");
  }
}
