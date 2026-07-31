// The credits model. 1 credit = $0.01 of real AI cost.
//
// Balances are derived by summing credit_ledger — never stored. Spends are
// metered from what each call actually cost (via estimateCostUsd), not from a
// fixed menu: fixed prices either overcharge the cheap actions or undercharge
// a big deck build, and the whole promise of the model is that a credit means
// a real cent.
//
// Running out breaks NOTHING except new AI calls. Collection, decks, values,
// trades, battles and exports never touch this module.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { AI_NAME } from "@/lib/branding";

/** One-time signup grant (≈ $1 of AI). Never refills — it sits there until
 *  used, however long that takes. */
export const SIGNUP_GRANT = 100;

/** Monthly grants by plan. Family is pooled across the whole group.
 *
 *  Sized so every paid tier clears its own AI bill at FULL consumption, not
 *  just at typical consumption. Family used to grant 2,000: $20 of AI against
 *  $18.15 of net revenue after card fees, so a household that actually used
 *  what it bought cost $1.85 a month to serve — and the loss only appeared
 *  once the plan was used as advertised, which is the worst way for a pricing
 *  bug to behave. 1,500 leaves ~$3.15, in line with Pro's ~$3.44.
 *
 *  It also fixes the ladder. At 2,000 credits Family sold them at roughly
 *  half Pro's rate per dollar, so a heavy solo user was better off buying
 *  Family for themselves. Family is still the cheaper way to buy credits —
 *  3x Pro's allowance for about twice the price — just not an arbitrage. */
export const MONTHLY_GRANT: Record<string, number> = {
  free: 0,
  pro: 500,
  family: 1500,
};

/** Endpoints that warm shared caches (card text read during a battle or deck
 *  load) are infrastructure, not a user action — the result is stored on the
 *  card row for everyone. Nobody's meter should tick for those. */
const UNMETERED_ENDPOINTS = new Set(["card_fx"]);

export function isMetered(endpoint: string): boolean {
  return !UNMETERED_ENDPOINTS.has(endpoint);
}

/** USD → whole credits, rounded up so fractions of a cent can't leak. */
export function creditsForUsd(usd: number): number {
  return Math.max(1, Math.ceil(usd * 100));
}

/** Typical costs per action at current models, for UI copy only ("a deck
 *  build usually runs 15–50 credits"). The ledger always debits actuals. */
/** What each AI action typically costs, in one place.
 *
 *  Ranges, not prices. The ledger debits what a call actually cost (1 credit
 *  = 1¢ of model spend), so a fixed menu would be a fiction — a scan of two
 *  cards and a scan of twenty are not the same call.
 *
 *  These numbers appear on exactly one page. They used to be printed on the
 *  buttons themselves ("Grade my card · 8–15 credits"), which put a price tag
 *  on every action in the product and made using it feel like running a
 *  meter. The balance is in the header; the detail lives at /credits for
 *  anyone who wants it.
 */
export const CREDIT_MENU = [
  { key: "scan", label: "Bulk scan", cost: "2–4", what: "One photo, up to 20 cards identified." },
  { key: "deck_build", label: "Deck build", cost: "15–50", what: "A full 60-card deck from your collection, with a strategy and a buy-list." },
  { key: "deck_review", label: "Deck review", cost: "5–15", what: "A written critique of a deck you built." },
  { key: "coach", label: "Coach reply", cost: "1–3", what: "One question about one deck." },
  { key: "chat", label: "TrainerAI chat", cost: "3–5", what: "One question. Costs a little more than the coach because it carries an index of your whole collection." },
  { key: "grade", label: "Grading report", cost: "8–15", what: "Corner, edge, surface and centering analysis from your photos." },
  { key: "trade_chat", label: "Trade advice", cost: "1–3", what: "Whether a proposed trade is fair." },
  { key: "find_image", label: "Card image search", cost: "1–5", what: "Finding artwork for a card the database has no picture for." },
] as const;

/** Keyed lookup, for anywhere that needs one action's range. */
export const ACTION_ESTIMATES: Record<string, string> = Object.fromEntries(
  CREDIT_MENU.map((m) => [m.key, m.cost])
);

/** The start of the user's current credit cycle.
 *
 *  Anchored to the day-of-month they signed up (clamped for short months, so
 *  a Jan 31 signup cycles on Feb 28, Mar 31, Apr 30…). When Stripe lands the
 *  anchor becomes the billing period; the maths here stays the same, only the
 *  anchor date changes.  All in UTC. */
export function cycleStart(anchorIso: string, now: Date = new Date()): Date {
  const anchor = new Date(anchorIso);
  const day = anchor.getUTCDate();
  const clamp = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  };
  let start = clamp(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = clamp(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return start;
}

/** Idempotency key for a cycle's grant — one grant per user per cycle. */
export function cycleRef(start: Date): string {
  return start.toISOString().slice(0, 10);
}

interface FamilyContext {
  groupId: string;
  ownerId: string;
  /** The owner's signup date. Every member's grant maths uses THIS anchor:
   *  if each member used their own, two members checking in the same month
   *  would compute different cycle refs for the owner's grant — and the
   *  idempotency key would let the pool be granted twice. */
  ownerAnchorIso: string;
  memberIds: string[];
  myCap: number | null;
}

async function familyContext(admin: SupabaseClient, userId: string): Promise<FamilyContext | null> {
  const { data: me } = await admin
    .from("family_members")
    .select("group_id, credit_cap")
    .eq("user_id", userId)
    .maybeSingle();
  if (!me) return null;
  const [{ data: group }, { data: members }] = await Promise.all([
    admin.from("family_groups").select("owner_user").eq("id", me.group_id).single(),
    admin.from("family_members").select("user_id").eq("group_id", me.group_id),
  ]);
  const ownerId = group?.owner_user as string;
  const { data: owner } = await admin
    .from("profiles")
    .select("created_at, billing_anchor")
    .eq("id", ownerId)
    .single();
  const memberIds = [...new Set([...(members ?? []).map((m) => m.user_id as string), ownerId])];
  return {
    groupId: me.group_id as string,
    ownerId,
    ownerAnchorIso:
      ((owner as { billing_anchor?: string | null } | null)?.billing_anchor as string | undefined) ??
      ((owner?.created_at as string) ?? new Date().toISOString()),
    memberIds,
    myCap: (me.credit_cap as number | null) ?? null,
  };
}

/** Make sure this user's grants exist, idempotently.
 *
 *  Grants are inserted lazily at check time rather than by a scheduler: the
 *  unique index (user, reason, ref) makes double-insertion impossible, and a
 *  user who never comes back never needs rows written. Family grants land on
 *  the group owner, since the pool is theirs. */
async function ensureGrants(
  admin: SupabaseClient,
  userId: string,
  plan: string,
  anchorIso: string,
  family: FamilyContext | null
): Promise<void> {
  const rows: Array<{ user_id: string; delta: number; reason: string; ref_id: string }> = [
    { user_id: userId, delta: SIGNUP_GRANT, reason: "signup_grant", ref_id: "once" },
  ];
  const grantee = family ? family.ownerId : userId;
  const grantPlan = family ? "family" : plan;
  const monthly = MONTHLY_GRANT[grantPlan] ?? 0;
  if (monthly > 0) {
    rows.push({
      user_id: grantee,
      delta: monthly,
      reason: "monthly_grant",
      ref_id: cycleRef(cycleStart(family ? family.ownerAnchorIso : anchorIso)),
    });
  }
  // Plain inserts, with the duplicate swallowed — NOT an upsert.
  //
  // The upsert this replaces asked for ON CONFLICT (user_id, reason, ref_id),
  // but that index is partial (WHERE ref_id IS NOT NULL). Postgres rejects a
  // conflict target that doesn't carry the index's predicate, which PostgREST
  // has no way to express, so every grant failed with 42P10 — and because the
  // call ended in `.then(() => {})`, which discards the error Supabase returns
  // rather than throws, it failed *silently*. New accounts were quietly never
  // given their signup credits and read as "out of credits" before spending
  // anything.
  //
  // Inserting and treating 23505 as success needs no conflict target at all,
  // so it works against the partial index exactly as intended: the second
  // attempt at the same (user, reason, ref) is a no-op. Anything else is a
  // real fault and gets logged instead of vanishing.
  for (const row of rows) {
    const { error } = await admin.from("credit_ledger").insert(row);
    if (error && error.code !== "23505") {
      console.error(`credit grant failed (${row.reason}):`, error.message);
    }
  }
}

async function sumDeltas(
  admin: SupabaseClient,
  userIds: string[],
  opts?: { since?: Date; negativeOnly?: boolean }
): Promise<number> {
  // Paged. PostgREST caps a response at 1,000 rows, and the ledger gains a
  // row per AI call — a few months of real use passes a thousand, at which
  // point an unpaged sum silently stops counting the rest and the balance
  // is simply wrong. Ordered totally so paging can't drop or repeat rows.
  const { data } = await fetchAllRows<{ delta: number }>(() => {
    let q = admin
      .from("credit_ledger")
      .select("delta")
      .in("user_id", userIds)
      .order("created_at")
      .order("id");
    if (opts?.since) q = q.gte("created_at", opts.since.toISOString());
    if (opts?.negativeOnly) q = q.lt("delta", 0);
    return q;
  });
  return data.reduce((s, r) => s + (r.delta ?? 0), 0);
}

/** Credits that were BOUGHT or GIVEN outright, and survive a plan ending.
 *
 *  A monthly allowance is rent: it comes with the subscription and goes with
 *  it. A boost is property — someone paid cash for those credits separately,
 *  and taking them back because a subscription lapsed would be keeping money
 *  for nothing. Admin grants sit on the same side: they were given to make
 *  something right, and expiring them would undo the apology.
 */
const PERSISTENT_REASONS = new Set([
  "boost",
  "boost_refund",
  "admin_grant",
  "admin_adjustment",
]);

/** End-of-subscription clean-up: monthly credits go, bought credits stay.
 *
 *  Spending draws down the monthly allowance FIRST and boosts last, which is
 *  the reading that favours the person who paid: you never lose a boost you
 *  bought because a plan you also paid for happened to expire. Concretely
 *  the surviving balance is whatever remains of the persistent credits, and
 *  the rest is written off with an explicit ledger row rather than by
 *  deleting history.
 *
 *  Returns how many credits were removed. Idempotent through `ref`: a
 *  redelivered cancellation cannot expire the same credits twice.
 */
export async function expirePlanCredits(
  admin: SupabaseClient,
  userId: string,
  ref: string
): Promise<number> {
  const { data } = await fetchAllRows<{ delta: number; reason: string }>(() =>
    admin
      .from("credit_ledger")
      .select("delta, reason")
      .eq("user_id", userId)
      .order("created_at")
      .order("id")
  );

  const balance = data.reduce((s, r) => s + (r.delta ?? 0), 0);
  if (balance <= 0) return 0;

  const persistent = data
    .filter((r) => PERSISTENT_REASONS.has(r.reason))
    .reduce((s, r) => s + (r.delta ?? 0), 0);

  // Can't survive more than is actually there, and can't be negative.
  const surviving = Math.max(0, Math.min(balance, persistent));
  const toExpire = balance - surviving;
  if (toExpire <= 0) return 0;

  const { error } = await admin.from("credit_ledger").insert({
    user_id: userId,
    delta: -toExpire,
    reason: "plan_expired",
    ref_id: ref,
  });
  // 23505 is the redelivery we wanted to ignore; anything else is real.
  if (error && error.code !== "23505") {
    console.error(`credit expiry failed for ${userId}: ${error.message}`);
    return 0;
  }
  return error ? 0 : toExpire;
}

/** How many saved decks a free account keeps. */
export const FREE_DECK_LIMIT = 5;

/** The free-tier test for PRODUCT gates — the deck cap, deck sharing — as
 *  opposed to the credit meter, which gates AI spend. A family member's own
 *  profile still reads 'free' (the family plan lives on the group owner's
 *  row), so membership has to be resolved before calling someone free.
 *
 *  Fails OPEN on lookup errors: a database hiccup must never lock a paying
 *  member out of a feature, and the worst case of failing open is a free
 *  user briefly slipping past a product gate, which costs nothing. */
export async function isFreeTier(
  user: { id: string },
  profile: { role?: string; plan?: string } | null
): Promise<boolean> {
  if (profile?.role === "admin") return false;
  if ((profile?.plan ?? "free") !== "free") return false;
  try {
    const admin = createAdminClient();
    return (await familyContext(admin, user.id)) == null;
  } catch {
    return false;
  }
}

export interface CreditStatus {
  ok: boolean;
  message?: string;
  balance: number;
  plan: string;
  /** Whether this user shares a family pool. */
  pooled: boolean;
}

/** May this user make another AI call?  Admins are never metered.
 *
 *  The gate requires a positive balance, then the call debits its ACTUAL
 *  cost afterwards — so the final call can push a balance slightly negative.
 *  That is standard metering: the alternative (pre-authorising a guess) blocks
 *  calls the user could afford. */
export async function checkCredits(
  user: { id: string },
  profile: { role?: string; plan?: string; created_at?: string; billing_anchor?: string | null } | null
): Promise<CreditStatus> {
  const plan = profile?.plan ?? "free";
  if (profile?.role === "admin") return { ok: true, balance: Infinity, plan, pooled: false };

  try {
    const admin = createAdminClient();
    // Always resolved, whatever this user's own plan says: the 'family' plan
    // lives on the group OWNER's profile, and a kid's own row still reads
    // 'free'. Membership is what makes the pool theirs.
    const family = await familyContext(admin, user.id);
    // Billing period once Stripe has set it, signup anniversary before then —
    // so grants line up with invoices the moment someone pays.
    const anchorIso =
      profile?.billing_anchor ?? profile?.created_at ?? new Date().toISOString();
    await ensureGrants(admin, user.id, plan, anchorIso, family);

    const poolIds = family ? family.memberIds : [user.id];
    const balance = await sumDeltas(admin, poolIds);

    // A balance of zero stops the NEXT request, never the one in flight.
    //
    // This is checked once, before the model is called, and the debit happens
    // afterwards from the usage it actually reported. So a request that
    // starts with one credit left runs to completion even if it costs fifty,
    // and the balance simply goes negative until the next refill. That is
    // deliberate and is promised on /credits: nobody gets cut off mid-answer
    // and charged for a truncated one. Do not "fix" this into a mid-flight
    // abort — an abandoned generation costs us exactly the same as a
    // finished one, and delivers nothing.
    if (balance <= 0) {
      return {
        ok: false,
        balance,
        plan,
        pooled: !!family,
        message:
          `You're out of ${AI_NAME} credits. Everything else keeps working — your collection, ` +
          `decks, values, trades and battles are all still here; only new ${AI_NAME} requests ` +
          `pause until your credits refill or you add a boost.`,
      };
    }

    // A kid profile's per-cycle cap is checked against their OWN spend, even
    // though the pool is shared.
    if (family && family.myCap != null) {
      const spent = -(await sumDeltas(admin, [user.id], {
        // The pool's clock, not the kid's: caps reset when the grant does.
        since: cycleStart(family.ownerAnchorIso),
        negativeOnly: true,
      }));
      if (spent >= family.myCap) {
        return {
          ok: false,
          balance,
          plan,
          pooled: true,
          message:
            `You've reached your ${family.myCap}-credit limit for this cycle. A parent can ` +
            `raise it in Family settings — everything except new ${AI_NAME} requests keeps working.`,
        };
      }
    }

    return { ok: true, balance, plan, pooled: !!family };
  } catch {
    // The meter must never take the product down with it. If the credits
    // tables are missing (pre-migration-026) or the query fails, allow the
    // call — the same fail-open stance the old budget check took.
    return { ok: true, balance: 0, plan, pooled: false };
  }
}

/** Debit one AI call's actual cost. Called from logAiUsage so every metered
 *  call flows through a single choke point. Service-role write; best-effort —
 *  a failed debit must not fail the user's request. */
export async function debitCredits(
  userId: string,
  endpoint: string,
  usd: number,
  refId?: string
): Promise<void> {
  if (!isMetered(endpoint)) return;
  try {
    const admin = createAdminClient();
    await admin.from("credit_ledger").insert({
      user_id: userId,
      delta: -creditsForUsd(usd),
      reason: endpoint,
      ref_id: refId ?? null,
    });
  } catch {
    // Pre-migration or transient failure: the ai_usage row still records the
    // true cost, so the books can be reconciled later.
  }
}

/** The numbers the meter UI needs, without gating anything. */
export async function creditSummary(
  user: { id: string },
  profile: { role?: string; plan?: string; created_at?: string; billing_anchor?: string | null } | null
): Promise<{
  balance: number;
  plan: string;
  pooled: boolean;
  cycleStart: string;
  monthlyGrant: number;
  spentByReason: Record<string, number>;
}> {
  const plan = profile?.plan ?? "free";
  const admin = createAdminClient();
  const family = await familyContext(admin, user.id);
  const anchorIso =
    profile?.billing_anchor ?? profile?.created_at ?? new Date().toISOString();
  await ensureGrants(admin, user.id, plan, anchorIso, family);
  const poolIds = family ? family.memberIds : [user.id];
  const start = cycleStart(family ? family.ownerAnchorIso : anchorIso);

  const [balance, { data: recent }] = await Promise.all([
    sumDeltas(admin, poolIds),
    admin
      .from("credit_ledger")
      .select("delta, reason")
      .in("user_id", poolIds)
      .gte("created_at", start.toISOString())
      .lt("delta", 0),
  ]);
  const spentByReason: Record<string, number> = {};
  for (const r of recent ?? []) {
    spentByReason[r.reason as string] = (spentByReason[r.reason as string] ?? 0) - (r.delta as number);
  }
  return {
    balance,
    plan,
    pooled: !!family,
    cycleStart: start.toISOString(),
    monthlyGrant: MONTHLY_GRANT[family ? "family" : plan] ?? 0,
    spentByReason,
  };
}
