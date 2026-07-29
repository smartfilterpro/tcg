import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureCustomer,
  planPriceId,
  stripeEnabled,
  stripeFetch,
  StripeError,
} from "@/lib/stripe";

export const maxDuration = 30;

/** POST { plan: "pro" | "family" } → a Stripe Checkout url.
 *
 *  The webhook is what actually changes the plan — this route only opens the
 *  door. Nothing about the account is touched until Stripe confirms payment. */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    if (!stripeEnabled()) {
      return NextResponse.json(
        { error: "Billing isn't configured yet (STRIPE_SECRET_KEY)." },
        { status: 503 }
      );
    }
    const { plan } = (await req.json().catch(() => ({}))) as { plan?: string };
    if (plan !== "pro" && plan !== "family") {
      return NextResponse.json({ error: "Pick a plan: pro or family." }, { status: 400 });
    }
    if ((profile?.plan ?? "free") !== "free") {
      return NextResponse.json(
        { error: "You already have a plan — manage it from the billing portal instead." },
        { status: 409 }
      );
    }

    const admin = createAdminClient();
    const customer = await ensureCustomer(
      admin,
      user.id,
      user.email ?? null,
      (profile?.stripe_customer as string | null) ?? null
    );
    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
    const priceId = await planPriceId(plan);

    const session = await stripeFetch("/checkout/sessions", {
      params: {
        mode: "subscription",
        customer,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/?upgraded=1`,
        cancel_url: `${origin}/?upgrade=cancelled`,
        // The plan rides on BOTH the session and the subscription: the
        // session copy fulfils checkout.session.completed, the subscription
        // copy keeps later subscription.updated events self-describing.
        metadata: { user_id: user.id, plan },
        subscription_data: { metadata: { user_id: user.id, plan } },
      },
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
      { error: err instanceof Error ? err.message : "Checkout failed" },
      { status: 500 }
    );
  }
}
