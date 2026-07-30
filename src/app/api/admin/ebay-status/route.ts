import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import {
  EbayError,
  SCOPE_BASE,
  SCOPE_INSIGHTS,
  ebayEnabled,
  ebayFetch,
  probeAccess,
} from "@/lib/ebay";

export const maxDuration = 30;

/** GET /api/admin/ebay-status — what the eBay keyset can actually do.
 *
 *  Two questions, both answered by asking eBay rather than by trusting the
 *  approval email:
 *
 *    1. Do the credentials work at all? (wrong key, sandbox key in the
 *       production slot, a newline pasted into Railway)
 *    2. Is Marketplace Insights granted? Sold prices are restricted access,
 *       and whether we have them decides whether an eBay price is worth
 *       showing at all — an asking price presented as a value is worse than
 *       the estimate we show today.
 *
 *  Also runs one real search per granted API, because a token proves the
 *  credentials and nothing about whether the endpoint answers. */
export async function GET() {
  try {
    await requireAdmin();

    const access = await probeAccess();
    const samples: Record<string, unknown> = {};

    // A card common enough that zero results means the query is wrong rather
    // than the market being thin.
    const q = "pokemon charizard";

    if (access.browse) {
      try {
        const json = await ebayFetch("/buy/browse/v1/item_summary/search", {
          params: { q, limit: 3 },
          scopes: [SCOPE_BASE],
        });
        const items = (json.itemSummaries as Array<Record<string, unknown>>) ?? [];
        samples.browse = {
          ok: true,
          total: json.total ?? null,
          examples: items.map((i) => ({
            title: i.title,
            price: (i.price as Record<string, unknown>)?.value ?? null,
            currency: (i.price as Record<string, unknown>)?.currency ?? null,
          })),
        };
      } catch (err) {
        samples.browse = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          status: err instanceof EbayError ? err.status : null,
        };
      }
    }

    if (access.insights) {
      try {
        const json = await ebayFetch("/buy/marketplace_insights/v1_beta/item_sales/search", {
          params: { q, limit: 3 },
          scopes: [SCOPE_BASE, SCOPE_INSIGHTS],
        });
        const items = (json.itemSales as Array<Record<string, unknown>>) ?? [];
        samples.insights = {
          ok: true,
          total: json.total ?? null,
          examples: items.map((i) => ({
            title: i.title,
            soldPrice: (i.lastSoldPrice as Record<string, unknown>)?.value ?? null,
            soldDate: i.lastSoldDate ?? null,
          })),
        };
      } catch (err) {
        samples.insights = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          status: err instanceof EbayError ? err.status : null,
        };
      }
    }

    return NextResponse.json({
      ...access,
      samples,
      verdict: !ebayEnabled()
        ? "Not configured."
        : access.insights
          ? "Sold-price data is available — eBay can back the grading value table."
          : access.browse
            ? "Asking prices only. Not a valuation source; apply for Marketplace Insights."
            : "Credentials rejected.",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("ebay status error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't check eBay" },
      { status: 500 }
    );
  }
}
