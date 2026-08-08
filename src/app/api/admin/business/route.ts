import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { rowCostUsd } from "@/lib/usage";
import { fetchAllRows } from "@/lib/fetchAll";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 60;

// The owner dashboard's numbers. Every figure is computed from real tables —
// profiles, ai_usage via estimateCostUsd, credit_ledger, boost_purchases,
// scan_events, support_tickets — never modelled. At dev scale the raw pulls
// are cheap; when they stop being cheap this becomes a nightly rollup.

const PLAN_CENTS: Record<string, number> = { pro: 900, family: 1900 };

export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const now = Date.now();
    const d30 = new Date(now - 30 * 86400_000).toISOString();
    const m7 = new Date(now - 7 * 30 * 86400_000).toISOString();

    const [profilesRes, usageRes, ledgerRes, boostsRes, scansRes, ticketsRes, stateRes, sharedRes, refusedRes] =
      await Promise.all([
        fetchAllRows(() =>
          admin.from("profiles").select("id, email, display_name, plan, role, created_at").order("id")
        ),
        fetchAllRows(() =>
          admin
            .from("ai_usage")
            .select("user_id, model, endpoint, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, created_at")
            .gte("created_at", m7)
            .order("created_at")
            .order("id")
        ),
        fetchAllRows(() =>
          admin
            .from("credit_ledger")
            .select("user_id, delta, reason, created_at")
            .gte("created_at", d30)
            .order("created_at")
            .order("id")
        ),
        admin
          .from("boost_purchases")
          .select("user_id, credits, amount_cents, status, created_at")
          .gte("created_at", m7),
        admin.from("scan_events").select("*").gte("created_at", d30),
        // Subject included so refund requests can be spotted: refunds are
        // never automated (payments are final by policy), so a refund ask
        // arrives as an ordinary ticket and deserves its own alert row.
        admin
          .from("support_tickets")
          .select("id, status, subject, created_at")
          .neq("status", "resolved"),
        // Every background job that can strand work reports here: the price
        // refresh's held prices, the catalogue import's stop-on-error, the
        // art mirror's failures. One query, picked apart by key below.
        admin
          .from("app_state")
          .select("key, value")
          .in("key", ["price_refresh", "card_import", "art_mirror"]),
        // Decks newly shared this week, by when sharing was switched on
        // (migration 041) — an old deck shared today counts, which is the
        // case the previous created_at proxy missed entirely.
        admin
          .from("decks")
          .select("id", { count: "exact", head: true })
          .eq("shared", true)
          .gte("shared_at", new Date(Date.now() - 7 * 86400_000).toISOString()),
        // Names refused by the screen this week (migration 042). Repeated
        // refusals from one person is the clearest statement of intent the
        // system ever gets — one is a typo, eight is a project.
        admin
          .from("name_audit")
          .select("user_id")
          .eq("allowed", false)
          .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString()),
      ]);
    const stateByKey = new Map(
      ((stateRes.data ?? []) as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value])
    );

    const profiles = (profilesRes.data ?? []) as Array<Record<string, unknown>>;
    const usage = (usageRes.data ?? []) as Array<Record<string, unknown>>;
    const ledger = (ledgerRes.data ?? []) as Array<Record<string, unknown>>;
    const boosts = ((boostsRes.data ?? []) as Array<Record<string, unknown>>).filter(
      (b) => b.status === "completed"
    );

    // ===== per-user & per-month cost =====
    const cost30ByUser = new Map<string, number>();
    const costByMonth = new Map<string, number>();
    const costByModel = new Map<string, number>();
    const costByEndpoint30 = new Map<string, number>();
    let cost30 = 0;
    for (const r of usage) {
      const cost = rowCostUsd(r as Parameters<typeof rowCostUsd>[0]);
      const at = r.created_at as string;
      costByMonth.set(at.slice(0, 7), (costByMonth.get(at.slice(0, 7)) ?? 0) + cost);
      if (at >= d30) {
        cost30 += cost;
        const uid = r.user_id as string;
        cost30ByUser.set(uid, (cost30ByUser.get(uid) ?? 0) + cost);
        const model = ((r.model as string) ?? "unknown").replace(/-\d{8}$/, "");
        costByModel.set(model, (costByModel.get(model) ?? 0) + cost);
        const ep = (r.endpoint as string) ?? "other";
        costByEndpoint30.set(ep, (costByEndpoint30.get(ep) ?? 0) + cost);
      }
    }

    // ===== plans / MRR =====
    const nonAdmin = profiles.filter((p) => p.role !== "admin");
    const byPlan = { free: 0, pro: 0, family: 0 } as Record<string, number>;
    for (const p of nonAdmin) byPlan[(p.plan as string) ?? "free"] = (byPlan[(p.plan as string) ?? "free"] ?? 0) + 1;
    const mrrCents = byPlan.pro * PLAN_CENTS.pro + byPlan.family * PLAN_CENTS.family;
    const boost30Cents = boosts
      .filter((b) => (b.created_at as string) >= d30)
      .reduce((s, b) => s + ((b.amount_cents as number) ?? 0), 0);
    const revenue30Cents = mrrCents + boost30Cents;

    // ===== monthly revenue bars (subscription grants + boosts, by month) =====
    const revByMonth = new Map<string, number>();
    for (const b of boosts) {
      const m = (b.created_at as string).slice(0, 7);
      revByMonth.set(m, (revByMonth.get(m) ?? 0) + ((b.amount_cents as number) ?? 0) / 100);
    }
    // monthly_grant deltas map back to their plan price.
    const grantRows = (
      await fetchAllRows(() =>
        admin
          .from("credit_ledger")
          .select("delta, created_at")
          .eq("reason", "monthly_grant")
          .gte("created_at", m7)
          .order("created_at")
          .order("id")
      )
    ).data ?? [];
    for (const g of grantRows as Array<Record<string, unknown>>) {
      const m = (g.created_at as string).slice(0, 7);
      const price = (g.delta as number) >= 2000 ? 19 : 9;
      revByMonth.set(m, (revByMonth.get(m) ?? 0) + price);
    }
    const months: Array<{ label: string; revenue: number; cost: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - i);
      const key = d.toISOString().slice(0, 7);
      months.push({
        label: d.toLocaleDateString(undefined, { month: "short" }),
        revenue: Math.round((revByMonth.get(key) ?? 0) * 100) / 100,
        cost: Math.round((costByMonth.get(key) ?? 0) * 100) / 100,
      });
    }

    // ===== credit economics (30d) =====
    let granted = 0;
    let spent = 0;
    for (const l of ledger) {
      const delta = l.delta as number;
      if (delta > 0) granted += delta;
      else spent -= delta;
    }
    const boostCreditsSold = boosts
      .filter((b) => (b.created_at as string) >= d30)
      .reduce((s, b) => s + ((b.credits as number) ?? 0), 0);

    const costsSorted = [...cost30ByUser.values()].sort((a, b) => b - a);
    const topN = Math.max(1, Math.ceil(costsSorted.length * 0.05));
    const top5Share =
      cost30 > 0 ? costsSorted.slice(0, topN).reduce((s, v) => s + v, 0) / cost30 : 0;

    // ===== customers table =====
    const boost30ByUser = new Map<string, number>();
    for (const b of boosts.filter((b) => (b.created_at as string) >= d30)) {
      boost30ByUser.set(
        b.user_id as string,
        (boost30ByUser.get(b.user_id as string) ?? 0) + ((b.amount_cents as number) ?? 0)
      );
    }
    const customers = nonAdmin
      .map((p) => {
        const id = p.id as string;
        const plan = ((p.plan as string) ?? "free") as "free" | "pro" | "family";
        const cost = cost30ByUser.get(id) ?? 0;
        const revCents = (PLAN_CENTS[plan] ?? 0) + (boost30ByUser.get(id) ?? 0);
        return {
          email: (p.email as string) ?? "",
          name: ((p.display_name as string | null) ?? "").trim() || null,
          plan,
          cost30: Math.round(cost * 100) / 100,
          revenue30: revCents / 100,
          margin: Math.round((revCents / 100 - cost) * 100) / 100,
          joined: (p.created_at as string) ?? null,
        };
      })
      .sort((a, b) => b.cost30 - a.cost30)
      .slice(0, 20);
    const overPlan = customers.filter((c) => c.margin < 0 && c.plan !== "free").length;

    // ===== scan quality (30d) — the same numbers the landing page quotes =====
    const scans = (scansRes.data ?? []) as Array<Record<string, number>>;
    const detected = scans.reduce((s, r) => s + (r.cards_detected ?? 0), 0);
    const auto = scans.reduce((s, r) => s + (r.cards_auto_matched ?? 0), 0);
    const secs = scans.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / 1000;
    const scanStats = {
      scans: scans.length,
      matchRate: detected > 0 ? Math.round((auto / detected) * 1000) / 10 : null,
      secondsPerCard: detected > 0 ? Math.round((secs / detected) * 10) / 10 : null,
      cardsPerScan: scans.length > 0 ? Math.round((detected / scans.length) * 10) / 10 : null,
    };

    // ===== needs-a-human alerts, from real sources only =====
    const suspicious =
      ((stateByKey.get("price_refresh") as { suspicious?: unknown[] } | null)?.suspicious ?? [])
        .length;
    // Each alert carries where the human acts on it — the concept's
    // "Needs a human" list has a button per row, not just prose.
    const alerts: Array<{
      severity: "red" | "amber";
      title: string;
      body: string;
      href: string;
      action: string;
    }> = [];
    if (overPlan > 0) {
      alerts.push({
        severity: "red",
        title: `${overPlan} paying account${overPlan === 1 ? " is" : "s are"} costing more than they pay`,
        body: "30-day AI cost above plan price. Consider a nudge to Family, or a cap.",
        href: "#members",
        action: "Review",
      });
    }
    const tickets = (ticketsRes.data ?? []) as Array<{
      status: string;
      subject: string | null;
      created_at: string | null;
    }>;
    // Refund asks get their own red row: there's no automated refund to
    // hide behind — payments are final by policy, so each of these is a
    // person waiting on the owner's judgment, not a queue item.
    const refundRe = /refund|money\s*back|chargeback/i;
    const refundTickets = tickets.filter((t) => refundRe.test(t.subject ?? "")).length;
    if (refundTickets > 0) {
      alerts.push({
        severity: "red",
        title: `${refundTickets} refund request${refundTickets === 1 ? "" : "s"} in the ticket queue`,
        body:
          "Payments are final by policy — any refund is goodwill you choose, case by case. " +
          "Decide and reply.",
        href: "#support",
        action: "Decide",
      });
    }
    // The month itself upside down beats every per-account signal.
    if (cost30 > revenue30Cents / 100 && cost30 > 1) {
      alerts.push({
        severity: "red",
        title: "AI cost exceeds revenue this month",
        body: `$${cost30.toFixed(2)} of AI against $${(revenue30Cents / 100).toFixed(2)} of revenue over 30 days. The heaviest spenders are in the table below.`,
        href: "#members",
        action: "See spenders",
      });
    }

    // Aging beats existing: a ticket a day old is a person giving up on you.
    const dayAgo = new Date(now - 86400_000).toISOString();
    const nonRefundOpen = tickets.filter(
      (t) => t.status === "open" && !refundRe.test(t.subject ?? "")
    );
    const aged = nonRefundOpen.filter((t) => (t.created_at ?? "") < dayAgo).length;
    if (aged > 0) {
      alerts.push({
        severity: "red",
        title: `${aged} support ticket${aged === 1 ? "" : "s"} unanswered over 24h`,
        body: "Still marked open a day after arriving.",
        href: "#support",
        action: "Open inbox",
      });
    }
    const openTickets = nonRefundOpen.length - aged;
    if (openTickets > 0) {
      alerts.push({
        severity: "amber",
        title: `${openTickets} open support ticket${openTickets === 1 ? "" : "s"}`,
        body: "Waiting in the support inbox.",
        href: "#support",
        action: "Open inbox",
      });
    }

    // The catalogue import stops on a hard error and then waits, silently,
    // for someone to press Continue — this is the someone-being-told part.
    const importState = stateByKey.get("card_import") as {
      error?: string | null;
      done?: boolean;
    } | null;
    if (importState?.error && importState.done !== true) {
      alerts.push({
        severity: "amber",
        title: "The catalogue import stopped on an error",
        body: `${String(importState.error).slice(0, 140)} — progress is saved; Continue picks up where it stopped.`,
        href: "#catalogue",
        action: "Continue import",
      });
    }

    // Mirror trouble: a failing image source the admin would otherwise
    // never see, because the page quietly falls back to hotlinking.
    const mirrorState = stateByKey.get("art_mirror") as {
      lastError?: string | null;
      lastRunFailed?: number;
    } | null;
    const mirrorFailures = mirrorState?.lastRunFailed ?? 0;
    if (mirrorState?.lastError || mirrorFailures > 0) {
      alerts.push({
        severity: "amber",
        title: mirrorState?.lastError
          ? "The art mirror hit an error on its last run"
          : `The art mirror failed on ${mirrorFailures} card${mirrorFailures === 1 ? "" : "s"} last run`,
        body:
          (mirrorState?.lastError ? `${String(mirrorState.lastError).slice(0, 140)}. ` : "") +
          "Failed cards stay hotlinked and are retried on a later sweep.",
        href: "#catalogue",
        action: "Check mirror",
      });
    }

    // Someone working the filter. The screen holds, but a person trying
    // repeatedly is telling you what they intend to do the moment it slips.
    const refusedRows = (refusedRes.error ? [] : (refusedRes.data ?? [])) as Array<{
      user_id: string;
    }>;
    const refusedByUser = new Map<string, number>();
    for (const r of refusedRows) {
      refusedByUser.set(r.user_id, (refusedByUser.get(r.user_id) ?? 0) + 1);
    }
    const persistent = [...refusedByUser.values()].filter((n) => n >= 3).length;
    if (refusedRows.length > 0) {
      alerts.push({
        severity: persistent > 0 ? "red" : "amber",
        title:
          persistent > 0
            ? `${persistent} member${persistent === 1 ? "" : "s"} repeatedly tried refused names`
            : `${refusedRows.length} name${refusedRows.length === 1 ? "" : "s"} refused this week`,
        body:
          persistent > 0
            ? "Three or more refusals each — the screen held, but that is someone working at it. Consider a name reset or a suspension."
            : "The name screen refused these. Worth a look at what was tried.",
        href: "#content",
        action: "Review names",
      });
    }

    // Moderation skim: sharing is where a bad deck name reaches everyone.
    // A pre-041 database has no shared_at: the query errors rather than
    // returning zero, and a silent zero would read as "nothing to skim".
    const sharedThisWeek = sharedRes.error ? 0 : (sharedRes.count ?? 0);
    if (sharedThisWeek > 0) {
      alerts.push({
        severity: "amber",
        title: `${sharedThisWeek} deck${sharedThisWeek === 1 ? "" : "s"} newly shared this week`,
        body: "Worth a skim of the names — the AI screen catches most, not all.",
        href: "#content",
        action: "Skim names",
      });
    }
    if (suspicious > 0) {
      alerts.push({
        severity: "amber",
        title: `Price refresh held ${suspicious} suspicious price${suspicious === 1 ? "" : "s"}`,
        body: "Values moved more than 5× and were not auto-applied — review under Price freshness.",
        href: "#catalogue",
        action: "Review",
      });
    }

    return NextResponse.json({
      kpis: {
        mrr: mrrCents / 100,
        payingCustomers: byPlan.pro + byPlan.family,
        totalAccounts: nonAdmin.length,
        aiCost30: Math.round(cost30 * 100) / 100,
        revenue30: revenue30Cents / 100,
        grossMarginPct:
          revenue30Cents > 0
            ? Math.round(((revenue30Cents / 100 - cost30) / (revenue30Cents / 100)) * 1000) / 10
            : null,
        conversionPct:
          nonAdmin.length > 0
            ? Math.round(((byPlan.pro + byPlan.family) / nonAdmin.length) * 1000) / 10
            : null,
      },
      months,
      planMix: [
        { label: "Free", count: byPlan.free, mrr: 0 },
        { label: "Pro · $9", count: byPlan.pro, mrr: (byPlan.pro * PLAN_CENTS.pro) / 100 },
        { label: "Family · $19", count: byPlan.family, mrr: (byPlan.family * PLAN_CENTS.family) / 100 },
      ],
      credits: {
        granted30: granted,
        spent30: spent,
        spentPct: granted > 0 ? Math.round((spent / granted) * 100) : null,
        boostCreditsSold30: boostCreditsSold,
        boostRevenue30: boost30Cents / 100,
        top5SharePct: Math.round(top5Share * 100),
      },
      modelSplit: [...costByModel.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([model, cost]) => ({ model, cost: Math.round(cost * 100) / 100 })),
      endpointSplit: [...costByEndpoint30.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([endpoint, cost]) => ({ endpoint, cost: Math.round(cost * 100) / 100 })),
      scanStats,
      alerts,
      customers,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
