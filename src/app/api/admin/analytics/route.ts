import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/usage";
import { itemPrice } from "@/lib/types";

export interface ScanStats {
  scans: number;
  avgSeconds: number | null;
  /** total scan time ÷ total cards detected — time per identified card */
  avgSecondsPerCard: number | null;
  avgCardsPerScan: number | null;
  /** % of detected cards that auto-matched a database card */
  matchRate: number | null;
  /** % of saved cards where the user kept the auto-match (scan was right) */
  accuracy: number | null;
}

function scanStats(rows: Array<Record<string, number>>): ScanStats {
  const scans = rows.length;
  if (scans === 0)
    return {
      scans: 0,
      avgSeconds: null,
      avgSecondsPerCard: null,
      avgCardsPerScan: null,
      matchRate: null,
      accuracy: null,
    };
  const sum = (k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const detected = sum("cards_detected");
  const auto = sum("cards_auto_matched");
  const saved = sum("cards_saved");
  const kept = sum("cards_kept_match");
  const totalSeconds = sum("duration_ms") / 1000;
  return {
    scans,
    avgSeconds: totalSeconds / scans,
    avgSecondsPerCard: detected > 0 ? totalSeconds / detected : null,
    avgCardsPerScan: detected / scans,
    matchRate: detected > 0 ? (auto / detected) * 100 : null,
    accuracy: saved > 0 ? (kept / saved) * 100 : null,
  };
}

/** GET: community + scanning analytics for the admin dashboard. */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const cutoff30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const [
      { count: members },
      { data: itemRows },
      { count: deckCount },
      { data: sharedDecks },
      { count: openPosts },
      { count: openTickets },
      { data: usageMonth },
      scanRes,
    ] = await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin
        .from("collection_items")
        .select("quantity, price_override, variant, card:cards(market_price, prices)")
        .limit(20000),
      admin.from("decks").select("id", { count: "exact", head: true }),
      admin.from("decks").select("id").eq("shared", true),
      admin.from("trade_posts").select("id", { count: "exact", head: true }).eq("status", "open"),
      admin
        .from("support_tickets")
        .select("id", { count: "exact", head: true })
        .neq("status", "resolved"),
      admin
        .from("ai_usage")
        .select("model, input_tokens, output_tokens")
        .gte("created_at", monthStart.toISOString())
        .limit(50000),
      admin.from("scan_events").select("*").order("created_at", { ascending: false }).limit(5000),
    ]);

    const items = (itemRows ?? []) as unknown as Array<{
      quantity: number;
      price_override: number | null;
      variant: string;
      card: { market_price: number | null; prices: Record<string, number | null> | null } | null;
    }>;
    let totalCards = 0;
    let totalValue = 0;
    for (const it of items) {
      totalCards += it.quantity;
      if (it.card) {
        totalValue += (itemPrice(it as Parameters<typeof itemPrice>[0]) ?? 0) * it.quantity;
      }
    }

    const aiCostMonth = (usageMonth ?? []).reduce(
      (s, r) => s + estimateCostUsd(r.model ?? "", r.input_tokens ?? 0, r.output_tokens ?? 0),
      0
    );

    // scan_events may not exist pre-migration-012
    const scanRows = (scanRes.error ? [] : (scanRes.data ?? [])) as Array<Record<string, number>> &
      Array<{ created_at?: string }>;
    const recent = scanRows.filter(
      (r) => ((r as { created_at?: string }).created_at ?? "") >= cutoff30d
    );

    return NextResponse.json({
      scanTracking: !scanRes.error,
      community: {
        members: members ?? 0,
        totalCards,
        totalValue,
        decks: deckCount ?? 0,
        sharedDecks: (sharedDecks ?? []).length,
        openTradePosts: openPosts ?? 0,
        openTickets: openTickets ?? 0,
        aiCostMonth,
      },
      scansAllTime: scanStats(scanRows),
      scans30d: scanStats(recent),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("analytics error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
