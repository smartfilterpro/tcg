import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { creditSummary } from "@/lib/credits";
import { stripeEnabled } from "@/lib/stripe";
import { errorJson } from "@/lib/apiError";

/** GET: everything the billing settings page shows. The charge history is
 *  assembled from OUR ledger and boost rows, not a Stripe API call — the
 *  page's job is "what did I pay and what did it grant", which the ledger
 *  answers exactly; full PDF invoices live in the Stripe portal. */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const admin = createAdminClient();
    const credits = await creditSummary(user, profile);

    const [{ data: grants }, { data: boosts }] = await Promise.all([
      admin
        .from("credit_ledger")
        .select("delta, reason, created_at")
        .eq("user_id", user.id)
        .eq("reason", "monthly_grant")
        .order("created_at", { ascending: false })
        .limit(24),
      admin
        .from("boost_purchases")
        .select("credits, amount_cents, status, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(24),
    ]);

    const plan = profile?.plan ?? "free";
    const planCents = plan === "pro" ? 900 : plan === "family" ? 1900 : 0;
    const charges = [
      ...(grants ?? []).map((g) => ({
        at: g.created_at as string,
        what: `${plan === "family" ? "Family" : "Pro"} — monthly subscription`,
        credits: g.delta as number,
        amountCents: planCents,
      })),
      ...(boosts ?? [])
        .filter((b) => b.status === "completed" || b.status === "refunded")
        .map((b) => ({
          at: b.created_at as string,
          what: `Boost pack — ${(b.credits as number).toLocaleString()} credits${
            b.status === "refunded" ? " (refunded)" : ""
          }`,
          credits: b.credits as number,
          amountCents: b.amount_cents as number,
        })),
    ].sort((a, b) => b.at.localeCompare(a.at));

    let renewsAt: string | null = null;
    if (plan !== "free") {
      const d = new Date(credits.cycleStart);
      d.setUTCMonth(d.getUTCMonth() + 1);
      renewsAt = d.toISOString();
    }

    return NextResponse.json({
      plan,
      planCents,
      renewsAt,
      expiresAt: (profile?.plan_expires_at as string | null) ?? null,
      stripeConfigured: stripeEnabled(),
      hasStripeCustomer: !!profile?.stripe_customer,
      credits,
      charges,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
