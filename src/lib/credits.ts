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
import { AI_NAME } from "@/lib/branding";

/** One-time signup grant (≈ $1 of AI). Never refills — it sits there until
 *  used, however long that takes. */
export const SIGNUP_GRANT = 100;

/** Monthly grants by plan. Family is pooled across the whole group. */
export const MONTHLY_GRANT: Record<string, number> = {
  free: 0,
  pro: 500,
  family: 2000,
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
export const ACTION_ESTIMATES: Record<string, string> = {
  scan: "2–4",
  deck_build: "15–50",
  deck_review: "5–15",
  grade: "8–15",
  coach: "1–3",
  trade_chat: "1–3",
  find_image: "1–5",
};

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
    .select("created_at")
    .eq("id", ownerId)
    .single();
  const memberIds = [...new Set([...(members ?? []).map((m) => m.user_id as string), ownerId])];
  return {
    groupId: me.group_id as string,
    ownerId,
    ownerAnchorIso: (owner?.created_at as string) ?? new Date().toISOString(),
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
  // upsert + ignoreDuplicates rides on the unique index — a racing request
  // inserts nothing and errors nothing.
  await admin
    .from("credit_ledger")
    .upsert(rows, { onConflict: "user_id,reason,ref_id", ignoreDuplicates: true })
    .then(() => {});
}

async function sumDeltas(
  admin: SupabaseClient,
  userIds: string[],
  opts?: { since?: Date; negativeOnly?: boolean }
): Promise<number> {
  let q = admin.from("credit_ledger").select("delta").in("user_id", userIds);
  if (opts?.since) q = q.gte("created_at", opts.since.toISOString());
  if (opts?.negativeOnly) q = q.lt("delta", 0);
  const { data } = await q;
  return (data ?? []).reduce((s, r) => s + (r.delta as number), 0);
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
  profile: { role?: string; plan?: string; created_at?: string } | null
): Promise<CreditStatus> {
  const plan = profile?.plan ?? "free";
  if (profile?.role === "admin") return { ok: true, balance: Infinity, plan, pooled: false };

  try {
    const admin = createAdminClient();
    // Always resolved, whatever this user's own plan says: the 'family' plan
    // lives on the group OWNER's profile, and a kid's own row still reads
    // 'free'. Membership is what makes the pool theirs.
    const family = await familyContext(admin, user.id);
    const anchorIso = profile?.created_at ?? new Date().toISOString();
    await ensureGrants(admin, user.id, plan, anchorIso, family);

    const poolIds = family ? family.memberIds : [user.id];
    const balance = await sumDeltas(admin, poolIds);

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
  profile: { role?: string; plan?: string; created_at?: string } | null
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
  const anchorIso = profile?.created_at ?? new Date().toISOString();
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
