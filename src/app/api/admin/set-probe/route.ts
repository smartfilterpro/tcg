import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { setNameClause } from "@/lib/pokemontcg";
import { createAdminClient } from "@/lib/supabase/admin";
import { priceTrackerEnabled, effectiveRemaining } from "@/lib/priceTracker";
import { readSyncState, trackerSetCards } from "@/lib/priceTrackerSync";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 120;

// Why a set search returns what it returns.
//
// The same questions as scripts/probe-set-search.sh, asked from the server
// instead of a terminal — because the person who needs the answer works from
// a phone, and a bash script with curl and jq is not a thing you can run on
// one. Same checks, same interpretation, tappable.
//
// It asks the sources DIRECTLY rather than going through our own search, so
// the answer says what upstream holds rather than what our code made of it.
// Three rounds of fixes went out on this without anyone seeing an upstream
// response, which is how "missing cards" turned into "wrong cards".
//
// Read-only. Nothing here writes, and every request is a free one.

const PT = "https://api.pokemontcg.io/v2";
const DEX = "https://api.tcgdex.net/v2/en";

interface Attempt {
  /** What was asked, in the source's own query language. */
  query: string;
  /** Why this one is worth asking. */
  asks: string;
  ok: boolean;
  count: number | null;
  /** Distinct set names in the result — the tell for a query gone broad. */
  sets?: string[];
  sample?: string[];
  error?: string;
}

function ptHeaders(): Record<string, string> {
  const key = (process.env.POKEMONTCG_API_KEY ?? "").trim();
  return key ? { "X-Api-Key": key } : {};
}

async function ptCards(query: string, asks: string, pageSize = 250): Promise<Attempt> {
  const url = new URL(`${PT}/cards`);
  url.searchParams.set("q", query);
  url.searchParams.set("pageSize", String(pageSize));
  try {
    const res = await fetch(url.toString(), {
      headers: ptHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      // The body, not just the number. Two of these came back as a bare
      // "error" in the panel and there was no way to tell a rejected query
      // from a rate limit — which are opposite problems with opposite fixes.
      const body = (await res.text().catch(() => "")).trim().slice(0, 200);
      return {
        query,
        asks,
        ok: false,
        count: null,
        error: `HTTP ${res.status}${body ? ` — ${body}` : " (no body)"}`,
      };
    }
    const json = (await res.json()) as {
      data?: Array<{ name: string; number: string; set?: { name?: string } }>;
      totalCount?: number;
    };
    const data = json.data ?? [];
    return {
      query,
      asks,
      ok: true,
      count: json.totalCount ?? data.length,
      sets: [...new Set(data.map((c) => c.set?.name ?? "?"))].slice(0, 12),
      sample: data.slice(0, 12).map((c) => `${c.number} ${c.name}`),
    };
  } catch (err) {
    return {
      query,
      asks,
      ok: false,
      count: null,
      error: err instanceof Error ? err.message : "failed",
    };
  }
}

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const setName = (url.searchParams.get("set") ?? "trick or trade").trim();
    const card = (url.searchParams.get("card") ?? "").trim();
    const notes: string[] = [];

    // 1. Does the set exist upstream at all, and under what name? Everything
    //    downstream is meaningless if the answer is no.
    const setsUrl = new URL(`${PT}/sets`);
    setsUrl.searchParams.set("q", `name:"${setName}"`);
    let upstreamSets: Array<{ id: string; name: string; total?: number; releaseDate?: string }> = [];
    let setsError: string | null = null;
    try {
      const res = await fetch(setsUrl.toString(), {
        headers: ptHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) setsError = `HTTP ${res.status}`;
      else {
        const json = (await res.json()) as {
          data?: Array<{ id: string; name: string; total?: number; releaseDate?: string }>;
        };
        upstreamSets = json.data ?? [];
      }
    } catch (err) {
      setsError = err instanceof Error ? err.message : "failed";
    }

    // 2-4. The three query shapes, so the difference between them is visible
    //      rather than argued about.
    const [exact, oldBroken, loose] = await Promise.all([
      ptCards(
        setNameClause(setName),
        "The exact-phrase query the app sends now. This is the one that has to work.",
      ),
      ptCards(
        `set.name:"${setName}*"`,
        "The query the app sent until today — a wildcard inside quotes. Expected to return NOTHING: Lucene matches the asterisk literally. If this has results, that diagnosis was wrong.",
        5
      ),
      ptCards(
        setNameClause(setName, true),
        "The loose fallback, one prefix term per word. Watch the set list: unrelated sets mean the engine ORs these terms and the form is too broad to use unfiltered.",
        40
      ),
    ]);

    // 5-6. The card itself, if one was named.
    const cardChecks: Attempt[] = [];
    if (card) {
      cardChecks.push(
        await ptCards(
          `name:${card} ${setNameClause(setName)}`,
          `Is ${card} in this set, according to pokemontcg.io?`,
          25
        )
      );
      cardChecks.push(
        await ptCards(
          `name:${card}`,
          `Every printing of ${card} they hold. If the bundle printing is here, the card exists and our SET query is the problem. If not, their catalogue lacks it and TCGdex is the only route.`,
          50
        )
      );
    }

    // 7. TCGdex, which catalogues promo bundles months earlier.
    let dexSets: Array<{ id: string; name: string; cards: number }> = [];
    let dexCards: string[] = [];
    let dexError: string | null = null;
    try {
      const res = await fetch(`${DEX}/sets`, {
        cache: "no-store",
        signal: AbortSignal.timeout(25_000),
      });
      const all = (await res.json()) as Array<{ id: string; name?: string }>;
      const wanted = setName.toLowerCase();
      const matches = (Array.isArray(all) ? all : [])
        .filter((s) => (s.name ?? "").toLowerCase().includes(wanted))
        .slice(0, 4);
      for (const m of matches) {
        const detail = (await (
          await fetch(`${DEX}/sets/${encodeURIComponent(m.id)}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(25_000),
          })
        ).json()) as { name?: string; cards?: Array<{ localId?: string; name: string }> };
        dexSets.push({ id: m.id, name: detail.name ?? m.name ?? m.id, cards: detail.cards?.length ?? 0 });
        for (const c of detail.cards ?? []) dexCards.push(`${c.localId ?? "?"} ${c.name}`);
      }
    } catch (err) {
      dexError = err instanceof Error ? err.message : "failed";
    }

    // 7b. The PAID source, which for a promo bundle is usually the ONLY
    //     source. Everything above can be a flat zero and the set still be
    //     perfectly well catalogued — at TCGplayer, behind the key.
    //
    //     Two halves, deliberately. The free half always runs: is the key
    //     set, how many credits are left today, and does their stored set
    //     list contain a set by this name. That answers "would we even ask?"
    //     for nothing. The billed half — actually fetching the cards, 200
    //     credits a set — runs only with &paid=1, because a diagnostic that
    //     quietly spends a fifth of the day's allowance every time it is
    //     opened is its own bug.
    const paidWanted = url.searchParams.get("paid") === "1";
    const admin = createAdminClient();
    const paid: Record<string, unknown> = {
      configured: priceTrackerEnabled(),
      creditsRemaining: effectiveRemaining(),
      fetched: false,
    };
    if (priceTrackerEnabled()) {
      const state = await readSyncState(admin);
      const known = state?.sets ?? [];
      const wanted = setName.toLowerCase();
      const matching = known.filter((s) => s.name.toLowerCase().includes(wanted));
      paid.knownSets = known.length;
      paid.matchingSets = matching.slice(0, 8);
      if (paidWanted) {
        const got = await trackerSetCards(admin, setName);
        paid.fetched = true;
        paid.count = got.cards.length;
        paid.log = got.log;
        paid.sample = got.cards.slice(0, 40).map((r) => `${r.number} ${r.name} [${r.set_name}]`);
      }
    }

    // 8. And what WE hold, so "upstream has it" can be told apart from "we
    //    imported it".
    const supabase = await createClient();
    const { data: ourRows } = await supabase
      .from("cards")
      .select("name, number, set_name")
      .ilike("set_name", `%${setName}%`)
      .limit(400);
    const ours = (ourRows ?? []) as Array<{ name: string; number: string; set_name: string }>;

    // The reading, written here so it doesn't have to be done by eye.
    if (setsError) notes.push(`Couldn't list sets upstream (${setsError}) — the rest may be unreliable.`);
    if (!setsError && upstreamSets.length === 0) {
      notes.push(
        `pokemontcg.io has NO set matching "${setName}". Nothing it returns for cards will be from that set, and TCGdex below is the only source that can help.`
      );
    }
    if (exact.ok && (exact.count ?? 0) === 0 && loose.ok && (loose.count ?? 0) > 0) {
      notes.push(
        "The exact phrase found nothing but the loose form found something — their set name is spelled differently from what was typed. Check the set list above and use that spelling."
      );
    }
    if (oldBroken.ok && (oldBroken.count ?? 0) > 0) {
      notes.push(
        "The old quoted-wildcard query DID return results, so the wildcard-in-quotes diagnosis was wrong and the set problem is something else."
      );
    }
    if (loose.ok && (loose.sets?.length ?? 0) > 2) {
      notes.push(
        `The loose form returned cards from ${loose.sets?.length} different sets — the engine is ORing those terms, which is why the listing filled with unrelated cards.`
      );
    }
    if (card && cardChecks[0]?.ok && (cardChecks[0].count ?? 0) === 0 && (cardChecks[1]?.count ?? 0) > 0) {
      notes.push(
        `${card} exists upstream but not under this set name — so either it isn't in this set, or the set is named differently there.`
      );
    }
    // The reading that matters for a promo bundle: both free databases at
    // zero means the listing is only ever as complete as the paid source was
    // allowed to be, and the paid source stops at 300 credits.
    const freeSourcesBlank = (exact.count ?? 0) === 0 && dexSets.length === 0;
    if (freeSourcesBlank && !priceTrackerEnabled()) {
      notes.push(
        `Neither free database has this set and the paid source has no key configured, so this set can only ever list the ${ours.length} cards already in our catalogue.`
      );
    } else if (freeSourcesBlank && (paid.creditsRemaining as number) < 300) {
      notes.push(
        `Neither free database has this set, and the paid source — the only one that does — has ${paid.creditsRemaining} credits left today, below the 300 it needs. THIS is why the set looks short: it is being listed from our own ${ours.length} rows alone. It will fill in when the allowance resets.`
      );
    } else if (freeSourcesBlank && (paid.knownSets as number | undefined) && (paid.matchingSets as unknown[]).length === 0) {
      notes.push(
        `Neither free database has this set, and none of the paid source's ${paid.knownSets} stored set names contains "${setName}" either. Try the spelling they use, or re-run the price sync to refresh their set list.`
      );
    } else if (freeSourcesBlank && !paidWanted) {
      notes.push(
        `Neither free database has this set. The paid source has ${(paid.matchingSets as unknown[]).length} set(s) by this name and ${paid.creditsRemaining} credits are available — add &paid=1 to actually fetch them (costs 200 credits per set).`
      );
    }
    if (ours.length > 0 && (exact.count ?? 0) > ours.length) {
      notes.push(
        `Our catalogue holds ${ours.length} cards from this set; upstream reports ${exact.count}. The import hasn't finished this set, which is why a search of our own rows alone comes up short.`
      );
    }

    return NextResponse.json({
      setName,
      card: card || null,
      upstreamSets,
      setsError,
      attempts: [exact, oldBroken, loose, ...cardChecks],
      tcgdex: { sets: dexSets, cards: dexCards.slice(0, 200), error: dexError },
      paid,
      ourCatalogue: {
        count: ours.length,
        setNames: [...new Set(ours.map((r) => r.set_name))],
        sample: ours.slice(0, 40).map((r) => `${r.number} ${r.name}`),
        hasCard: card
          ? ours.some((r) => r.name.toLowerCase() === card.toLowerCase())
          : null,
      },
      notes,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Probe failed");
  }
}
