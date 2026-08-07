import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/usage";
import { itemPrice } from "@/lib/types";
import { lastPriceRefresh } from "@/lib/priceRefresh";
import { fetchAllRows } from "@/lib/fetchAll";
import { errorJson } from "@/lib/apiError";

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

/** Group raw variant strings into the finishes people actually talk about. */
function finishBucket(variant: string): string {
  const v = variant.toLowerCase();
  if (variant === "normal") return "Normal";
  if (v.includes("reverse")) return "Reverse Holo";
  if (v.includes("holo")) return "Holo";
  if (v.includes("stamp")) return "Stamped";
  return "Other";
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
      finishRes,
    ] = await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      // Paged (fetchAllRows): Supabase caps every response at 1000 rows, so
      // these totals silently undercounted once tables grew past that.
      fetchAllRows(() =>
        admin
          .from("collection_items")
          .select("quantity, price_override, variant, card:cards(market_price, prices)")
          .order("created_at")
          .order("id")
      ),
      admin.from("decks").select("id", { count: "exact", head: true }),
      admin.from("decks").select("id").eq("shared", true),
      admin.from("trade_posts").select("id", { count: "exact", head: true }).eq("status", "open"),
      admin
        .from("support_tickets")
        .select("id", { count: "exact", head: true })
        .neq("status", "resolved"),
      fetchAllRows(
        () =>
          admin
            .from("ai_usage")
            .select("model, input_tokens, output_tokens")
            .gte("created_at", monthStart.toISOString())
            .order("created_at")
            .order("id"),
        50000
      ),
      fetchAllRows(
        () =>
          admin
            .from("scan_events")
            .select("*")
            .order("created_at", { ascending: false })
            .order("id"),
        5000
      ),
      fetchAllRows(() =>
        admin
          .from("finish_feedback")
          .select("predicted, corrected")
          .order("created_at")
          .order("id")
      ),
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

    // finish_feedback may not exist pre-migration-018
    const finishRows = (finishRes.error ? [] : (finishRes.data ?? [])) as Array<{
      predicted: string;
      corrected: string;
    }>;
    const finishSamples = finishRows.length;
    const finishCorrected = finishRows.filter((r) => r.predicted !== r.corrected).length;

    // Per-finish breakdown: how accurate is the scanner when it CLAIMS a
    // card is normal / holo / reverse holo / stamped?
    const byBucket = new Map<string, { samples: number; kept: number }>();
    const confusionCounts = new Map<string, number>();
    for (const r of finishRows) {
      const bucket = finishBucket(r.predicted);
      const entry = byBucket.get(bucket) ?? { samples: 0, kept: 0 };
      entry.samples += 1;
      if (r.predicted === r.corrected) entry.kept += 1;
      else {
        const key = `${bucket}|${finishBucket(r.corrected)}`;
        confusionCounts.set(key, (confusionCounts.get(key) ?? 0) + 1);
      }
      byBucket.set(bucket, entry);
    }
    const byFinish = ["Normal", "Holo", "Reverse Holo", "Stamped", "Other"]
      .filter((b) => byBucket.has(b))
      .map((b) => {
        const e = byBucket.get(b)!;
        return { finish: b, samples: e.samples, accuracy: (e.kept / e.samples) * 100 };
      });
    const confusions = [...confusionCounts.entries()]
      .map(([key, count]) => {
        const [from, to] = key.split("|");
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const priceRefresh = await lastPriceRefresh();

    // Grading history (table exists after migration 024).
    const gradeRes = await fetchAllRows(() =>
      admin
        .from("grade_reports")
        .select("estimated_grade, created_at")
        .order("created_at", { ascending: false })
        .order("id")
    );
    const gradeRows = (gradeRes.error ? [] : gradeRes.data) as Array<{
      estimated_grade: number | string | null;
      created_at: string;
    }>;
    const gradeValues = gradeRows
      .map((r) => (r.estimated_grade == null ? null : Number(r.estimated_grade)))
      .filter((n): n is number => n != null && Number.isFinite(n));
    const gradeBuckets = [
      { label: "10", test: (g: number) => g >= 10 },
      { label: "9–9.5", test: (g: number) => g >= 9 && g < 10 },
      { label: "8–8.5", test: (g: number) => g >= 8 && g < 9 },
      { label: "7–7.5", test: (g: number) => g >= 7 && g < 8 },
      { label: "under 7", test: (g: number) => g < 7 },
    ].map((b) => ({ label: b.label, count: gradeValues.filter(b.test).length }));

    return NextResponse.json({
      priceRefresh,
      grading: {
        tracking: !gradeRes.error,
        total: gradeRows.length,
        last30d: gradeRows.filter((r) => (r.created_at ?? "") >= cutoff30d).length,
        avgGrade:
          gradeValues.length > 0
            ? gradeValues.reduce((s, g) => s + g, 0) / gradeValues.length
            : null,
        distribution: gradeBuckets.filter((b) => b.count > 0),
      },
      scanTracking: !scanRes.error,
      finish: {
        tracking: !finishRes.error,
        samples: finishSamples,
        corrected: finishCorrected,
        accuracy: finishSamples > 0 ? ((finishSamples - finishCorrected) / finishSamples) * 100 : null,
        byFinish,
        confusions,
      },
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
    return errorJson(err, "Request failed");
  }
}
