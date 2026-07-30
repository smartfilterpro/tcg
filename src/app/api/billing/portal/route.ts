import { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/requestOrigin";
import { requireUser, AuthError } from "@/lib/auth";
import { stripeEnabled, stripeFetch, StripeError } from "@/lib/stripe";

export const maxDuration = 30;

/** POST → a Stripe customer-portal url: cards, invoices, cancelling.
 *  Cancelling there sets cancel_at_period_end, so access runs to the end of
 *  the paid cycle — the webhook handles the downgrade when it lands. */
export async function POST(req: Request) {
  try {
    const { profile } = await requireUser();
    if (!stripeEnabled()) {
      return NextResponse.json(
        { error: "Billing isn't configured yet (STRIPE_SECRET_KEY)." },
        { status: 503 }
      );
    }
    const customer = (profile?.stripe_customer as string | null) ?? null;
    if (!customer) {
      return NextResponse.json(
        { error: "No billing history yet — upgrade or buy a boost first." },
        { status: 404 }
      );
    }
    const origin = requestOrigin(req);
    const session = await stripeFetch("/billing_portal/sessions", {
      params: { customer, return_url: `${origin}/` },
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof StripeError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't open the billing portal" },
      { status: 500 }
    );
  }
}
