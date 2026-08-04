// The card search pipeline, in one place.
//
// This lived inside the route handler, which meant the only way to find out
// why a search returned what it returned was to read the code and imagine.
// Several rounds of "it's showing the wrong cards" were diagnosed that way
// and two of those diagnoses were wrong.
//
// So the pipeline moved here and learned to narrate itself. Every stage
// appends to a trace: what the query parsed to, what our catalogue answered,
// whether the external sources were consulted and WHY, what each of them
// returned, what the merge folded away as a duplicate, and what the final cap
// cut off. The route ignores the trace; the admin probe shows it. One
// implementation, so the explanation cannot drift from the behaviour it is
// explaining — which is the whole reason not to write the probe twice.

import type { SupabaseClient } from "@supabase/supabase-js";
import { searchCards, numberKey, cleanCardName, numberVariants } from "@/lib/pokemontcg";
import { searchTcgdex, tcgdexSetCards } from "@/lib/tcgdex";
import { parseCardQuery, type ParsedCardQuery } from "@/lib/cardQuery";
import { normalizeForSearch } from "@/lib/text";
import { rowToSummary, type CardSummary, type CardSummaryRow } from "@/lib/types";
import { trackerSetCards, trackerSearchCards } from "@/lib/priceTrackerSync";
import { createAdminClient } from "@/lib/supabase/admin";

/** The primary API has been flaky — an error there must not kill the search,
 *  because our catalogue and the TCGdex fallback can still answer. */
async function safeSearch(
  opts: Parameters<typeof searchCards>[0]
): Promise<ReturnType<typeof searchCards> extends Promise<infer T> ? T : never> {
  try {
    return await searchCards(opts);
  } catch {
    return [];
  }
}

/** How many cards a "set:" listing may return.
 *
 *  Big enough for any real set — the largest modern sets run past 250 once
 *  secret rares are counted, and a Trick or Trade bundle mixes reprints from
 *  several — because the failure this replaces was a set quietly appearing
 *  to be half its size. */
const SET_LIMIT = 400;

const SUMMARY_COLS =
  "id, name, supertype, subtypes, types, hp, number, rarity, set_id, set_name, set_series, set_printed_total, release_date, image_small, image_large, market_price, prices";

/** Every spelling a collector number might be stored under. Our own rows
 *  come from three databases that disagree about leading zeros — the same
 *  card is "050" from one source and "50" from another — so a search for
 *  either spelling has to reach both. */
function storedNumberVariants(n: string): string[] {
  const raw = n.trim();
  const out = new Set<string>([raw, raw.toUpperCase(), raw.toLowerCase()]);
  const prefixed = raw.match(/^([A-Za-z]*)(\d+)$/);
  if (prefixed) {
    const letters = prefixed[1];
    const unpadded = prefixed[2].replace(/^0+(?=\d)/, "");
    for (const d of [unpadded, unpadded.padStart(2, "0"), unpadded.padStart(3, "0")]) {
      if (letters) {
        out.add(letters.toUpperCase() + d);
        out.add(letters.toLowerCase() + d);
      } else {
        out.add(d);
      }
    }
  }
  return [...out];
}

/** Our own card catalogue, searched first. It's the only source that is
 *  instant, never rate-limited, and never down — the external APIs turned
 *  "search" into a coin flip (pokemontcg.io's 500s are on record), which is
 *  exactly what made numbers with leading zeros feel haunted: each retry
 *  path handled zeros differently. Here one variant list handles them. */
async function searchCatalogue(
  supabase: SupabaseClient,
  parsed: ParsedCardQuery
): Promise<CardSummary[]> {
  const name = parsed.name ? cleanCardName(parsed.name) : "";
  const variants = parsed.number ? storedNumberVariants(parsed.number) : [];
  const set = parsed.setName?.trim();

  // "set:Trick or Trade" with nothing else — list the set.
  //
  // Not a search that happens to return a lot, but the actual request: show
  // me what is in this set so I can pick the one I'm holding. Ordered by
  // collector number the way the cards are ordered in the binder, which is
  // the order somebody entering a bundle will be going through them.
  if (set && !name && variants.length === 0) {
    const { data } = await supabase
      .from("cards")
      .select(SUMMARY_COLS)
      .ilike("set_name", `%${set}%`)
      .limit(400);
    const rows = (data ?? []) as unknown as CardSummaryRow[];
    return rows
      .sort((a, b) => {
        const n = (v: string) => {
          const d = (v ?? "").replace(/\D/g, "");
          return d ? parseInt(d, 10) : Number.MAX_SAFE_INTEGER;
        };
        return n(a.number) - n(b.number) || a.number.localeCompare(b.number);
      })
      .map((r) => rowToSummary(r));
  }

  const run = async (withTotal: boolean, withName: boolean) => {
    let q = supabase.from("cards").select(SUMMARY_COLS).limit(200);
    if (variants.length > 0) q = q.in("number", variants);
    if (withName && name) q = q.ilike("name", `%${name}%`);
    if (set) q = q.ilike("set_name", `%${set}%`);
    if (withTotal && parsed.printedTotal) {
      q = q.eq("set_printed_total", Number(parsed.printedTotal));
    }
    const { data } = await q;
    return (data ?? []) as unknown as CardSummaryRow[];
  };

  // Full constraints first, then relax: printedTotal counts only the base
  // set (secret rares exceed it), and an ilike name can miss punctuation
  // spellings — each relaxation keeps the stronger signal (the number).
  let rows = await run(true, true);
  if (rows.length === 0 && parsed.printedTotal) rows = await run(false, true);
  if (rows.length === 0 && name && variants.length > 0) {
    const all = await run(false, false);
    const wanted = normalizeForSearch(name);
    rows = all.filter((r) => normalizeForSearch(r.name).includes(wanted));
    // The number alone still identifies a short list — better to show the
    // right number under a slightly different name than nothing.
    if (rows.length === 0) rows = all.slice(0, 40);
  }
  // Punctuation-blind name fallback: fetch on the longest word, match the
  // rest normalized ("farfetchd" → Farfetch'd).
  if (rows.length === 0 && name && variants.length === 0) {
    const tokens = name.split(/\s+/).filter((t) => t.length >= 3);
    const anchor = tokens.sort((a, b) => b.length - a.length)[0];
    if (anchor) {
      const { data } = await supabase
        .from("cards")
        .select(SUMMARY_COLS)
        .ilike("name", `%${anchor}%`)
        .limit(200);
      const all = (data ?? []) as unknown as CardSummaryRow[];
      rows = all.filter((r) => {
        const n = normalizeForSearch(r.name);
        return tokens.every((t) => n.includes(normalizeForSearch(t)));
      });
    }
  }
  return rows.map((r) => rowToSummary(r));
}

export interface SearchStage {
  stage: string;
  detail: string;
  count?: number;
  /** Kept short — enough to recognise, not enough to drown the panel. */
  sample?: string[];
}

export interface SearchTrace {
  query: string;
  parsed: Record<string, unknown>;
  listingSet: boolean;
  needExternal: boolean;
  stages: SearchStage[];
  /** Cards dropped by the merge because something already claimed their
   *  identity. The most common cause of "it's missing" that isn't missing. */
  foldedAway: string[];
  /** Cards dropped by the result cap, which is the other one. */
  cutByLimit: string[];
}

export interface SearchOutcome {
  cards: CardSummary[];
  source: string;
  trace: SearchTrace;
}

/** Search every source for a typed query, and record how it got there. */
export async function runCardSearch(
  supabase: SupabaseClient,
  q: string,
  opts?: {
    /** Ask EVERY source, including the paid one, whatever the catalogue
     *  already returned.
     *
     *  Normal searches stop at the catalogue once it has answered, which is
     *  right for the common case and wrong for the one that keeps coming up:
     *  a printing the catalogue hasn't got. TCGplayer splits ball-pattern
     *  reverse holos into separate products — "Pikachu (Friend Ball)" — and
     *  names them distinctly enough that they survive as separate cards, but
     *  only the paid source knows them. This is billed, so it happens when
     *  somebody asks rather than on every keystroke. */
    deep?: boolean;
  }
): Promise<SearchOutcome> {
  const label = (c: CardSummary) => `${c.number} ${c.name} [${c.setName ?? "?"}]`;
  const stages: SearchStage[] = [];
  const note = (stage: string, detail: string, list?: CardSummary[]) =>
    stages.push({
      stage,
      detail,
      ...(list ? { count: list.length, sample: list.slice(0, 8).map(label) } : {}),
    });

    const parsed = parseCardQuery(q);
    const wantedKey = parsed.number ? numberKey(parsed.number) : "";
    const wantedName = parsed.name ? normalizeForSearch(cleanCardName(parsed.name)) : "";
    const hasWantedNumber = (list: CardSummary[]) =>
      !wantedKey || list.some((c) => numberKey(c.number) === wantedKey);

    const local = await searchCatalogue(supabase, parsed);
    note("catalogue", "Our own cards table.", local);

    // The external cascade is a supplement now, not the search. It runs only
    // when the catalogue couldn't fully answer: the requested number wasn't
    // found locally, or a name-only search came back thin (the catalogue is
    // still importing, so absence local isn't absence).
    // Listing a set ALWAYS consults the external sources, even when the
    // catalogue answered.
    //
    // The first version only went outside when nothing came back locally, on
    // the reasoning that our own rows are a complete answer. They are not: the
    // catalogue import is still walking the sets, so a half-imported set
    // answers confidently with half its cards and the rest are simply absent —
    // which is exactly how a Haunter goes missing from a bundle that plainly
    // contains one. "We hold some of this set" says nothing about whether we
    // hold all of it, and the merge below folds the duplicates anyway.
    const listingSet = !!parsed.setName && !parsed.name && !parsed.number;
    const needExternal = opts?.deep
      ? true
      : listingSet
      ? true
      : parsed.setName
        ? local.length === 0
        : wantedKey
          ? !hasWantedNumber(local)
          : local.length < 8;

    note(
      "decide",
      needExternal
        ? listingSet
          ? "Listing a set always asks outside — our rows are only as complete as the import."
          : parsed.setName
            ? "Set named and the catalogue had nothing."
            : wantedKey
              ? "The catalogue has no card with that collector number."
              : `The catalogue returned ${local.length}, fewer than the 8 that counts as a full answer.`
        : listingSet
          ? "(unreachable)"
          : wantedKey
            ? "The catalogue already has that collector number — no external call."
            : `The catalogue returned ${local.length}, enough to answer without asking outside. A card the import hasn't reached yet is invisible here.`
    );

    let cards: CardSummary[] = [];
    let source = local.length > 0 ? "catalogue" : "pokemontcg.io";
    if (needExternal) {
      // A single query shape can't cover how people type. A prefix match
      // misses "Surfing Pikachu" when you search "pikachu"; a contains match
      // is broad but the API may refuse a leading wildcard; token matching
      // gets past apostrophes and punctuation. Run them together and merge.
      if (parsed.name) {
        const shapes = await Promise.all([
          safeSearch({ ...parsed, pageSize: 60 }),
          safeSearch({
            nameContains: parsed.name,
            number: parsed.number,
            printedTotal: parsed.printedTotal,
            pageSize: 60,
          }),
          safeSearch({
            nameTokens: parsed.name,
            number: parsed.number,
            printedTotal: parsed.printedTotal,
            pageSize: 60,
          }),
        ]);
        const seen = new Set<string>();
        for (const shape of shapes) {
          for (const c of shape) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            cards.push(c);
          }
        }
      } else if (parsed.setName && !parsed.number) {
        // Set with no card named: ask for the set itself, generously. This
        // is somebody about to enter a bundle card by card, so a short page
        // is the wrong shape of answer.
        //
        // Exact phrase first. The loose form — every word as its own prefix
        // term — only runs if the phrase found nothing, because a term like
        // "or*" is close to matching everything and a set listing full of
        // unrelated cards is worse than a short one.
        cards = await safeSearch({ setName: parsed.setName, pageSize: 250 });
        if (cards.length === 0) {
          cards = await safeSearch({
            setName: parsed.setName,
            looseSetName: true,
            pageSize: 250,
          });
          // Whatever the engine did with those terms, the answer has to
          // actually be from a set the person named. Checked here rather
          // than trusted, since the loose query is the one that can wander.
          const wanted = parsed.setName.trim().toLowerCase();
          cards = cards.filter((c) => (c.setName ?? "").toLowerCase().includes(wanted));
        }
      } else {
        cards = await safeSearch({ ...parsed, pageSize: 30 });
      }

      // The upstream API doesn't reliably honour a parenthesised OR of the
      // ways a collector number can be spelled — retry each spelling on its
      // own before relaxing anything else.
      if (parsed.number && !hasWantedNumber(cards) && !hasWantedNumber(local)) {
        for (const variant of numberVariants(parsed.number)) {
          const exact = await safeSearch({
            name: parsed.name,
            numberExact: variant,
            printedTotal: parsed.printedTotal,
            pageSize: 16,
          });
          if (hasWantedNumber(exact) && exact.length > 0) {
            cards = [...exact, ...cards];
            break;
          }
        }
      }

      // Number searches can be over-constrained (printedTotal counts only
      // the base set; promo-set codes vary) — relax progressively.
      if (cards.length === 0 && (parsed.printedTotal || parsed.setName)) {
        cards = await safeSearch({ name: parsed.name, number: parsed.number, pageSize: 16 });
      }
      if (cards.length === 0 && parsed.number && !parsed.name) {
        cards = await safeSearch({ name: q, pageSize: 16 });
      }
      // XY-era Mega Evolutions are named "M Gengar-EX", not "Mega Gengar EX".
      if (cards.length === 0 && parsed.name && /^mega\s+/i.test(parsed.name)) {
        const oldStyle = parsed.name.replace(/^mega\s+/i, "M ").replace(/\s*ex$/i, "");
        cards = await safeSearch({ name: oldStyle, number: parsed.number, pageSize: 16 });
      }
      // Punctuation-blind retry ("farfetchd" → Farfetch'd).
      if (cards.length === 0 && parsed.name) {
        cards = await safeSearch({ nameTokens: parsed.name, number: parsed.number, pageSize: 16 });
        if (cards.length === 0 && parsed.number) {
          cards = await safeSearch({ nameTokens: parsed.name, pageSize: 16 });
        }
      }

      // Listing a set asks TCGdex too, always.
      //
      // Promo products — Trick or Trade bundles, blisters, tins — land there
      // months before pokemontcg.io catalogues them, and they are exactly
      // the sets somebody types a set name to enter. Asking only when the
      // other two came back empty would miss the common case, which is a set
      // that is PARTLY known to them and complete here.
      if (listingSet && parsed.setName) {
        const afterPt = cards.length;
        note("pokemontcg.io", "Set listing.", cards);
        cards.push(...(await tcgdexSetCards(parsed.setName)));
        const afterDex = cards.length;
        note("tcgdex", "Set listing.", cards.slice(afterPt));

        // The PAID source, last, and only for a set listing.
        //
        // Some sets exist nowhere else. "Trick or Trade BOOster Bundle 2024"
        // returns zero sets from pokemontcg.io and zero from TCGdex, while
        // our own catalogue holds eighteen of its cards — because the paid
        // sync created them as it walked. TCGplayer knows that product;
        // the two free databases do not catalogue promo bundles at all.
        // Leaving it out meant a listing that looked like the set is
        // eighteen cards long.
        //
        // Last because it is billed, and only for a listing because that is
        // the query where a missing card is the whole answer. The lookup
        // itself resolves the set id from a list the sync already paid for,
        // and caches the cards for an hour.
        try {
          const paid = await trackerSetCards(createAdminClient(), parsed.setName);
          cards.push(...paid.map((r) => rowToSummary(r)));
          note("price tracker (paid)", "Set listing — the source of last resort.", cards.slice(afterDex));
        } catch {
          note("price tracker (paid)", "Unavailable — no key, no budget, or the call failed.");
        }
      }

      // TCGdex usually has new sets/promos months earlier — consult it when
      // nothing yet carries the number that was searched for.
      if (!listingSet && ((local.length === 0 && cards.length === 0) || !hasWantedNumber([...local, ...cards]))) {
        const alt = await searchTcgdex({
          name: parsed.name ? cleanCardName(parsed.name) : undefined,
          number: parsed.number,
          pageSize: 12,
        });
        cards.push(...alt);
      }
      // The paid source, by name, only when asked for. Its parenthetical
      // product names are the whole point: they are what separates a Friend
      // Ball printing from the plain one, and no free database carries them.
      if (opts?.deep) {
        // A NAME is required to ask them anything useful, and "55/217" has
        // none.
        //
        // Their search spans a name and a number together; a bare number
        // matches half the game and fifteen results of noise is worse than
        // none. But a number-only query is not nameless in practice — the
        // catalogue has just told us what card 55/217 is. So the names come
        // from what we found locally, which is exactly the card whose other
        // printings are being asked about.
        //
        // Two names at most. One number can be several cards across sets,
        // and this is billed per call.
        const names = parsed.name
          ? [parsed.name]
          : [...new Set([...local, ...cards].map((c) => c.name))].slice(0, 2);

        if (names.length === 0) {
          note("price tracker (paid)", "Nothing to ask by: no card name in the query and none found locally.");
        }
        for (const name of names) {
          const before = cards.length;
          try {
            const paid = await trackerSearchCards(
              name,
              parsed.number ?? null,
              createAdminClient()
            );
            cards.push(...paid.map((r) => rowToSummary(r)));
            note(
              `price tracker (paid) — ${name}`,
              "Separate products per printing. The ball patterns, the stamped versions and anything else they name apart live here, each with its own price.",
              cards.slice(before)
            );
          } catch {
            note("price tracker (paid)", "Unavailable — no key, no budget, or the call failed.");
          }
        }
      }

      if (cards.length > 0) source = local.length > 0 ? "mixed" : "external";
    }

    // Merge, with the catalogue's copies first (they carry our images and
    // prices), and twins folded: the same physical card can arrive from two
    // sources under different ids AND different zero-paddings.
    const seen = new Set<string>();
    // Set name is part of the twin key normally — the same card in two sets
    // is two cards — but NOT when a single set is being listed. The three
    // sources spell a promo bundle differently ("Trick or Trade BOOster
    // Bundle 2024" against TCGdex's shorter name), so including it there
    // would fold nothing and show every card two or three times.
    const twin = (c: CardSummary) =>
      listingSet
        ? `${normalizeForSearch(c.name)}|${numberKey(c.number)}`
        : `${normalizeForSearch(c.name)}|${numberKey(c.number)}|${(c.setName ?? "").toLowerCase()}`;
    const merged: CardSummary[] = [];
    const foldedAway: string[] = [];
    for (const c of [...local, ...cards]) {
      const t = twin(c);
      if (seen.has(c.id) || seen.has(t)) {
        foldedAway.push(label(c));
        continue;
      }
      seen.add(c.id);
      seen.add(t);
      merged.push(c);
    }
    note("merge", `${local.length} local + ${cards.length} external, duplicates folded.`, merged);

    // The ranking the complaint was actually about: a card carrying the
    // EXACT number you typed belongs at the top, zeros ignored — name
    // closeness only breaks ties. Newest printing first within each band.
    const rank = (c: CardSummary) => {
      const numberMiss = wantedKey ? (numberKey(c.number) === wantedKey ? 0 : 1) : 0;
      const n = normalizeForSearch(c.name);
      const nameRank = !wantedName
        ? 0
        : n === wantedName
          ? 0
          : n.startsWith(wantedName)
            ? 1
            : n.includes(wantedName)
              ? 2
              : 3;
      return numberMiss * 10 + nameRank;
    };
    // Listing a set is a different job from searching for a card, and it
    // wants a different order and a different limit.
    //
    // Order: collector number. The rank above scores every card 0 when
    // there is no name or number to match, so a set listing fell through to
    // "newest release first" — meaningless within one set, and it threw away
    // the binder order the catalogue query had already sorted into. Somebody
    // entering a bundle is holding the cards in number order.
    //
    // Limit: 40 was silently cutting a set in half. It is the right size for
    // a search — nobody scrolls past forty Charizards — and the wrong size
    // for "show me everything in this set", where the missing entries look
    // like the set is missing them.
    if (listingSet) {
      const asNumber = (v: string) => {
        const digits = (v ?? "").replace(/\D/g, "");
        return digits ? parseInt(digits, 10) : Number.MAX_SAFE_INTEGER;
      };
      merged.sort(
        (a, b) => asNumber(a.number) - asNumber(b.number) || a.number.localeCompare(b.number)
      );
      const kept = merged.slice(0, SET_LIMIT);
      note("order + cap", `Sorted by collector number, capped at ${SET_LIMIT}.`, kept);
      return {
        cards: kept,
        source,
        trace: {
          query: q,
          parsed: { ...parsed },
          listingSet,
          needExternal,
          stages,
          foldedAway,
          cutByLimit: merged.slice(SET_LIMIT).map(label),
        },
      };
    }

    merged.sort(
      (a, b) => rank(a) - rank(b) || (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")
    );

    const kept = merged.slice(0, 40);
    note("order + cap", "Sorted by number match, then name closeness, then newest. Capped at 40.", kept);
    return {
      cards: kept,
      source,
      trace: {
        query: q,
        parsed: { ...parsed },
        listingSet,
        needExternal,
        stages,
        foldedAway,
        cutByLimit: merged.slice(40).map(label),
      },
    };
}
