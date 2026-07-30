import { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/requestOrigin";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { BOOST_PACKS, ensureCustomer, stripeEnabled, stripeFetch, StripeError } from "@/lib/stripe";

export const maxDuration = 30;

/** POST { pack: "250" | "750" | "2000" } → a Stripe Checkout url for a
 *  one-off boost. No subscription is created or changed.
 *
 *  A pending boost_purchases row is written BEFORE checkout opens, keyed by
 *  the session id, and the webhook flips it to completed and credits the
 *  ledger. Credits are granted only on the webhook — optimistic granting
 *  would hand out credits for abandoned checkouts. */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    if (!stripeEnabled()) {
      return NextResponse.json(
        { error: "Billing isn't configured yet (STRIPE_SECRET_KEY)." },
        { status: 503 }
      );
    }
    const { pack } = (await req.json().catch(() => ({}))) as { pack?: string };
    const spec = pack ? BOOST_PACKS[pack] : undefined;
    if (!spec) {
      return NextResponse.json({ error: "Pick a boost pack: 250, 750 or 2000." }, { status: 400 });
    }

    // A kid profile never reaches Stripe: their boost becomes a parent
    // approval request in Phase 5. Until that flow exists, refuse cleanly.
    const admin = createAdminClient();
    const { data: membership } = await admin
      .from("family_members")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (membership?.role === "kid") {
      return NextResponse.json(
        { error: "Boosts on a kid profile need a parent — ask them to add credits." },
        { status: 403 }
      );
    }

    const customer = await ensureCustomer(
      admin,
      user.id,
      user.email ?? null,
      (profile?.stripe_customer as string | null) ?? null
    );
    const origin = requestOrigin(req);

    const session = await stripeFetch("/checkout/sessions", {
      params: {
        mode: "payment",
        customer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: spec.cents,
              product_data: { name: `TrainerDeck Boost — ${spec.label}` },
            },
          },
        ],
        success_url: `${origin}/?boost=1`,
        cancel_url: `${origin}/?boost=cancelled`,
        metadata: { user_id: user.id, kind: "boost", pack, credits: String(spec.credits) },
      },
    });

    await admin.from("boost_purchases").insert({
      user_id: user.id,
      pack,
      credits: spec.credits,
      amount_cents: spec.cents,
      status: "pending",
      stripe_checkout_session: session.id as string,
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
      { error: err instanceof Error ? err.message : "Boost checkout failed" },
      { status: 500 }
    );
  }
}
