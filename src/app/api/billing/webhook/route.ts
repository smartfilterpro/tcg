import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripeFetch, verifyStripeSignature } from "@/lib/stripe";
import { expirePlanCredits } from "@/lib/credits";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 60;

// The only writer of plan state and paid credits. Publicly reachable by
// design — authentication is the signature, and everything inside is
// idempotent because Stripe retries deliveries: replaying any event must
// change nothing the second time.

type Obj = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Resolve which user an event belongs to. Metadata first (we stamp it on
 *  sessions and subscriptions at creation); the stored customer id is the
 *  fallback for events created outside our flow (e.g. portal actions). */
async function userForEvent(
  admin: ReturnType<typeof createAdminClient>,
  meta: Obj | null,
  customerId: string | null
): Promise<string | null> {
  const fromMeta = str(meta?.user_id);
  if (fromMeta) return fromMeta;
  if (!customerId) return null;
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("stripe_customer", customerId)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

async function handleSubscription(admin: ReturnType<typeof createAdminClient>, sub: Obj) {
  const userId = await userForEvent(admin, (sub.metadata as Obj) ?? null, str(sub.customer));
  if (!userId) {
    // Silent here meant a paid subscription that never reached an account.
    console.error(
      `BILLING: subscription ${str(sub.id)} for customer ${str(sub.customer)} ` +
        `matched no user — no metadata.user_id and no profile with that ` +
        `stripe_customer. The plan was NOT applied.`
    );
    return;
  }
  const status = str(sub.status);
  const plan = str((sub.metadata as Obj)?.plan) === "family" ? "family" : "pro";

  if (status === "canceled" || status === "incomplete_expired") {
    // The paid period is over (deletion fires at period end when the user
    // cancelled through the portal). Down to free; the ledger keeps history.
    await admin
      .from("profiles")
      .update({ plan: "free", stripe_subscription: null, plan_expires_at: null, billing_anchor: null })
      .eq("id", userId);
    // The month's allowance goes with the month. Boosts and support grants
    // stay: those were bought or given outright, and clawing them back
    // because a subscription lapsed would be keeping money for nothing.
    // Keyed to the subscription so a redelivered cancellation can't expire
    // the same credits twice.
    const expired = await expirePlanCredits(admin, userId, `sub:${str(sub.id) ?? "unknown"}`);
    if (expired > 0) {
      console.log(`BILLING: ${expired} plan credits expired for ${userId} at cancellation.`);
    }
    return;
  }
  if (status !== "active" && status !== "trialing" && status !== "past_due") return;

  const periodStart = typeof sub.current_period_start === "number" ? sub.current_period_start : null;
  const periodEnd = typeof sub.current_period_end === "number" ? sub.current_period_end : null;
  await admin
    .from("profiles")
    .update({
      plan,
      stripe_subscription: str(sub.id),
      // Anchors credit cycles to the billing period from here on.
      billing_anchor: periodStart ? new Date(periodStart * 1000).toISOString() : null,
      // Set only while a cancellation is pending: the UI reads it as "Pro
      // until <date>", and access genuinely runs to that date.
      plan_expires_at:
        sub.cancel_at_period_end === true && periodEnd
          ? new Date(periodEnd * 1000).toISOString()
          : null,
    })
    .eq("id", userId);
}

/** Write one credit_ledger row, exactly once, keyed by (user, reason, ref).
 *
 *  NOT an upsert. The unique index behind that guarantee is partial —
 *  `... (user_id, reason, ref_id) where ref_id is not null` — and Postgres
 *  will only infer a partial index for ON CONFLICT if the statement repeats
 *  the index predicate, which PostgREST's `onConflict=` has no way to send.
 *  So every upsert here failed with 42P10 no matter what the data was, and
 *  because neither call inspected the returned error, both failed silently:
 *  a paid boost credited nothing, and a refund clawed nothing back.
 *
 *  Plain insert needs no conflict target at all, so the partial index does
 *  its job: the second attempt at the same (user, reason, ref) raises 23505
 *  and is the redelivery we wanted to ignore. Anything else is a real fault
 *  and must be loud — this is money. */
async function grantOnce(
  admin: ReturnType<typeof createAdminClient>,
  row: { user_id: string; delta: number; reason: string; ref_id: string }
): Promise<void> {
  const { error } = await admin.from("credit_ledger").insert(row);
  if (error && error.code !== "23505") {
    console.error(
      `BILLING: ${row.reason} of ${row.delta} credits failed for ${row.user_id} ` +
        `(ref ${row.ref_id}): ${error.message}`
    );
  }
}

async function handleCheckoutCompleted(admin: ReturnType<typeof createAdminClient>, session: Obj) {
  const meta = (session.metadata as Obj) ?? null;
  if (str(session.mode) === "payment" && str(meta?.kind) === "boost") {
    const sessionId = str(session.id);
    const userId = await userForEvent(admin, meta, str(session.customer));
    if (!sessionId || !userId) return;

    // Flip pending → completed. The filter on status makes the update a
    // no-op on redelivery, and the ledger's unique (user, reason, ref)
    // index refuses a second grant even if the row was already flipped.
    await admin
      .from("boost_purchases")
      .update({ status: "completed", stripe_payment_intent: str(session.payment_intent) })
      .eq("stripe_checkout_session", sessionId)
      .eq("status", "pending");

    const credits = Number(str(meta?.credits)) || 0;
    if (credits > 0) {
      await grantOnce(admin, {
        user_id: userId,
        delta: credits,
        reason: "boost",
        ref_id: sessionId,
      });
    }
  }
  // A subscription checkout.
  //
  // This USED to do nothing, on the reasoning that customer.subscription.*
  // carries the same information. True — but only if the endpoint in the
  // Stripe dashboard is subscribed to those events, and an endpoint created
  // with just checkout.session.completed is a normal thing to end up with.
  // The symptom is the worst kind: payment succeeds, Stripe shows the
  // subscription, and the app still says Free.
  //
  // So the session now applies the plan itself by fetching the subscription
  // it created. If both events arrive, the second is a no-op — handleSubscription
  // writes the same row either way.
  if (str(session.mode) === "subscription") {
    const subId = str(session.subscription);
    if (!subId) return;
    try {
      const sub = await stripeFetch(`/subscriptions/${subId}`, { method: "GET" });
      // The session's metadata is the more reliable of the two: we stamp it
      // at creation, whereas a subscription made through the portal may carry
      // none. Prefer it, fall back to the subscription's own.
      const merged: Obj = {
        ...sub,
        metadata: { ...((sub.metadata as Obj) ?? {}), ...((meta ?? {}) as Obj) },
      };
      await handleSubscription(admin, merged);
    } catch (err) {
      // Loud: this is the path between a customer paying and getting what
      // they paid for.
      console.error(
        `BILLING: checkout ${str(session.id)} completed but the subscription ` +
          `could not be applied: ${err instanceof Error ? err.message : err}`
      );
      throw err; // 500 → Stripe retries, which is what we want here.
    }
  }
}

async function handleRefund(admin: ReturnType<typeof createAdminClient>, charge: Obj) {
  const paymentIntent = str(charge.payment_intent);
  if (!paymentIntent) return;
  const { data: purchase } = await admin
    .from("boost_purchases")
    .select("user_id, credits, status, stripe_checkout_session")
    .eq("stripe_payment_intent", paymentIntent)
    .maybeSingle();
  if (!purchase || purchase.status !== "completed") return;

  await admin
    .from("boost_purchases")
    .update({ status: "refunded" })
    .eq("stripe_payment_intent", paymentIntent)
    .eq("status", "completed");
  // The claw-back mirrors the grant, keyed to the same session so a
  // redelivered refund event can't double-debit.
  await grantOnce(admin, {
    user_id: purchase.user_id as string,
    delta: -(purchase.credits as number),
    reason: "boost_refund",
    ref_id: (purchase.stripe_checkout_session as string) ?? paymentIntent,
  });
}

export async function POST(req: Request) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    // Same stance as the cron route: an unverifiable webhook that can mint
    // credits is worse than none.
    return NextResponse.json({ error: "Webhook not configured." }, { status: 503 });
  }
  const rawBody = await req.text();
  if (!verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  let event: Obj;
  try {
    event = JSON.parse(rawBody) as Obj;
  } catch {
    return NextResponse.json({ error: "Bad payload." }, { status: 400 });
  }
  const type = str(event.type) ?? "";
  const object = ((event.data as Obj)?.object as Obj) ?? {};
  const admin = createAdminClient();

  try {
    if (type === "checkout.session.completed") {
      await handleCheckoutCompleted(admin, object);
    } else if (
      type === "customer.subscription.created" ||
      type === "customer.subscription.updated" ||
      type === "customer.subscription.deleted"
    ) {
      await handleSubscription(admin, object);
    } else if (type === "charge.refunded") {
      await handleRefund(admin, object);
    }
    // Everything else: acknowledged and ignored.
    return NextResponse.json({ received: true });
  } catch (err) {
    // A 500 makes Stripe retry — which is exactly right for a transient
    // database failure, and harmless for everything else because every
    // handler is idempotent.
    return errorJson(err, "Webhook handling failed");
  }
}
