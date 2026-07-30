import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import {
  budgetState,
  extractImageUrls,
  extractMarketPrice,
  priceTrackerEnabled,
  ptFetch,
} from "@/lib/priceTracker";

export const maxDuration = 60;

// Is the Pokémon Price Tracker key working, and what does it return?
//
// One call, against the documented endpoint, reporting what came back and
// what it cost. The same shape of diagnostic as /api/admin/ebay-status,
// which caught a wrong API version in a single click.
//
// GET /api/admin/price-tracker-status
//   ?path=/cards        endpoint to try (/sets and /population also exist)
//   &name=Pikachu       search term
//   &raw=1              include the response body

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const path = url.searchParams.get("path") || "/cards";
    const name = url.searchParams.get("name") || "Charizard";
    const includeRaw = url.searchParams.get("raw") === "1";

    if (!priceTrackerEnabled()) {
      return NextResponse.json({
        configured: false,
        verdict: "POKEMONPRICETRACKER_API_KEY isn't set.",
      });
    }

    let body: unknown = null;
    let error: string | null = null;
    try {
      // limit=1, because credits are billed on the requested limit, not on
      // matches. A diagnostic that costs 50 credits per press would be its
      // own small bug.
      body = await ptFetch(path, { search: name, limit: "1" });
    } catch (err) {
      error = err instanceof Error ? err.message : "failed";
    }

    const images = body ? extractImageUrls(body) : [];
    const price = body ? extractMarketPrice(body) : null;

    return NextResponse.json({
      configured: true,
      endpoint: path,
      budget: budgetState(),
      error,
      imagesFound: images.length,
      sampleImages: images.slice(0, 4),
      samplePrice: price,
      verdict: error
        ? // 403 on /population is expected rather than broken: GemRate data
          // is a Business-plan endpoint and this account is on Personal.
          /403/.test(error) && path.includes("population")
          ? "403 — /population is Business-plan only. Expected on the Personal plan."
          : `Failed: ${error}`
        : images.length === 0
          ? "Authenticated, but no image URLs came back. Re-run with &raw=1 and send me the shape."
          : `Working — ${images.length} image URLs, market price ${price ?? "n/a"}.`,
      ...(includeRaw ? { raw: body } : {}),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Check failed" },
      { status: 500 }
    );
  }
}
