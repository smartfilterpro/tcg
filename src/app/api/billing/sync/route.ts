import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCustomer, stripeEnabled, stripeFetch, StripeError } from "@/lib/stripe";
import { expirePlanCredits } from "@/lib/credits";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 30;

/** POST → re-read this account's subscription from Stripe and apply it.
 *
 *  The webhook is still the normal path. This exists because the webhook can
 *  miss: an endpoint configured without customer.subscription.* events, a
 *  delivery that failed while the app was deploying, a signing secret rotated
 *  mid-flight. All of those look identical to the person who paid — money
 *  gone, plan still Free — and none of them are fixable by waiting, because
 *  Stripe will not resend an event that was already accepted.
 *
 *  Stripe is the source of truth either way, so asking it directly is safe:
 *  this can only ever set the plan to what Stripe already says it is. */
export async function POST() {
  try {
    const { user, profile } = await requireUser();
    if (!stripeEnabled()) {
      return NextResponse.json(
        { error: "Billing isn't configured yet (STRIPE_SECRET_KEY)." },
        { status: 503 }
      );
    }

    const admin = createAdminClient();
    const customer = await ensureCustomer(
      admin,
      user.id,
      user.email ?? null,
      (profile?.stripe_customer as string | null) ?? null
    );

    const subs = await stripeFetch("/subscriptions", {
      method: "GET",
      params: { customer, status: "all", limit: 10 },
    });
    const list = (subs.data as Array<Record<string, unknown>>) ?? [];
    const live = list.find((s) =>
      ["active", "trialing", "past_due"].includes(String(s.status))
    );

    if (!live) {
      // Nothing live at Stripe. If the profile still claims a plan, that's
      // the stale side — clear it rather than leaving someone on a tier they
      // are not paying for.
      if ((profile?.plan ?? "free") !== "free") {
        await admin
          .from("profiles")
          .update({
            plan: "free",
            stripe_subscription: null,
            plan_expires_at: null,
            billing_anchor: null,
          })
          .eq("id", user.id);
        // Same rule as the webhook: the monthly allowance ends with the
        // plan, anything bought or granted outright stays.
        const expired = await expirePlanCredits(admin, user.id, `sync:${customer}`);
        return NextResponse.json({
          ok: true,
          plan: "free",
          message:
            "Stripe has no active subscription for you, so the plan is back to Free." +
            (expired > 0
              ? ` ${expired.toLocaleString()} plan credits ended with it; any boost credits you bought are still here.`
              : ""),
        });
      }
      return NextResponse.json({
        ok: true,
        plan: "free",
        message:
          "Stripe has no subscription for this account. If you just paid, give it a moment and " +
          "try again — and check the email address on the receipt matches this one.",
      });
    }

    const meta = (live.metadata as Record<string, unknown>) ?? {};
    // Trust the subscription's own price over metadata where they disagree:
    // metadata is what we asked for, the price is what is actually billed.
    const items = ((live.items as Record<string, unknown>)?.data ?? []) as Array<
      Record<string, unknown>
    >;
    const cents = Number(
      ((items[0]?.price as Record<string, unknown>)?.unit_amount as number) ?? 0
    );
    const plan =
      cents === 1900 ? "family" : cents === 900 ? "pro" : meta.plan === "family" ? "family" : "pro";

    const periodStart =
      typeof live.current_period_start === "number" ? live.current_period_start : null;
    const periodEnd = typeof live.current_period_end === "number" ? live.current_period_end : null;

    const { error } = await admin
      .from("profiles")
      .update({
        plan,
        stripe_customer: customer,
        stripe_subscription: String(live.id),
        billing_anchor: periodStart ? new Date(periodStart * 1000).toISOString() : null,
        plan_expires_at:
          live.cancel_at_period_end === true && periodEnd
            ? new Date(periodEnd * 1000).toISOString()
            : null,
      })
      .eq("id", user.id);
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      plan,
      message: `Synced from Stripe — you're on ${plan === "family" ? "Family" : "Pro"}.`,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof StripeError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("billing sync error", err);
    return errorJson(err, "Couldn't sync with Stripe");
  }
}
