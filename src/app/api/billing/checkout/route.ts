import { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/requestOrigin";
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

class CheckoutRefused extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** Open a Checkout session for a plan, or explain why not.
 *
 *  The webhook is what actually changes the plan — this only opens the door.
 *  Nothing about the account is touched until Stripe confirms payment. */
async function checkoutUrl(req: Request, plan: string | null): Promise<string> {
  const { user, profile } = await requireUser();
  if (!stripeEnabled()) {
    throw new CheckoutRefused("Billing isn't configured yet (STRIPE_SECRET_KEY).", 503);
  }
  if (plan !== "pro" && plan !== "family") {
    throw new CheckoutRefused("Pick a plan: pro or family.", 400);
  }
  if ((profile?.plan ?? "free") !== "free") {
    throw new CheckoutRefused(
      "You already have a plan — manage it from the billing portal instead.",
      409
    );
  }

  const admin = createAdminClient();
    const customer = await ensureCustomer(
      admin,
      user.id,
      user.email ?? null,
      (profile?.stripe_customer as string | null) ?? null
    );
    const origin = requestOrigin(req);
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
  return session.url as string;
}

function refusalStatus(err: unknown): { message: string; status: number } {
  if (err instanceof AuthError) return { message: err.message, status: err.status };
  if (err instanceof CheckoutRefused) return { message: err.message, status: err.status };
  // Stripe's message is written for a developer reading a dashboard, not
  // for somebody trying to pay — and it names our own account objects.
  if (err instanceof StripeError) {
    console.error("checkout: stripe refused", err);
    return { message: "The payment provider refused the request. Try again shortly.", status: 502 };
  }
  console.error("checkout failed", err);
  return { message: "Checkout failed", status: 500 };
}

/** POST { plan } → { url }. What the in-app upgrade buttons call. */
export async function POST(req: Request) {
  try {
    const { plan } = (await req.json().catch(() => ({}))) as { plan?: string };
    return NextResponse.json({ url: await checkoutUrl(req, plan ?? null) });
  } catch (err) {
    const { message, status } = refusalStatus(err);
    return NextResponse.json({ error: message }, { status });
  }
}

/** GET ?plan=pro → 303 into Stripe.
 *
 *  This exists so signup can *redirect* into payment. A brand-new account
 *  that has to confirm its email comes back through /auth/callback, and a
 *  redirect target has to be a GET — there is no way to POST from the end of
 *  an email link. It also means pasting this URL in a browser does something
 *  sensible instead of rendering an error page.
 *
 *  Failures land on /pricing with the reason in the query rather than as raw
 *  JSON, because a person arriving here came from a signup form, not fetch(). */
export async function GET(req: Request) {
  const plan = new URL(req.url).searchParams.get("plan");
  const origin = requestOrigin(req);
  try {
    return NextResponse.redirect(await checkoutUrl(req, plan), 303);
  } catch (err) {
    const { message, status } = refusalStatus(err);
    // Not signed in yet — send them to log in and come straight back.
    if (status === 401) {
      const back = encodeURIComponent(`/api/billing/checkout?plan=${plan ?? ""}`);
      return NextResponse.redirect(new URL(`/login?next=${back}`, origin), 303);
    }
    // Already subscribed: nothing to buy, show them what they have.
    if (status === 409) {
      return NextResponse.redirect(new URL("/settings/billing?already=1", origin), 303);
    }
    return NextResponse.redirect(
      new URL(`/pricing?checkout=failed&reason=${encodeURIComponent(message)}`, origin),
      303
    );
  }
}
