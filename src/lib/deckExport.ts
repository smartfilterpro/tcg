// A deck, in the exact text the official Pokémon TCG Live client imports.
//
// The format is unforgiving in specific ways, learned from a real Live
// export:
//
//     Pokémon: 8              ← counts LINES (distinct cards), not copies
//     4 Charmander PFL 11     ← qty, printed name, PTCGO set code, number
//     Trainer: 17
//     4 Rare Candy MEG 125
//     Energy: 1
//     11 Basic {R} Energy MEE 2   ← basic energy is written with its symbol
//     Total Cards: 60
//
// The set code is the part our catalogue doesn't hold: Live keys on PTCGO
// abbreviations ("OBF", "MEW"), which pokemontcg.io publishes per set as
// ptcgoCode. That list is fetched once and cached in app_state; rows that
// arrived from TCGdex or the price sync resolve their code by set NAME
// instead of id, through the same loose matcher the rest of the app uses.
// A line whose code can't be resolved is still written — Live shows it as
// unrecognised rather than failing the whole paste — and reported back so
// the UI can say which cards may need picking by hand.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSetCodes } from "@/lib/pokemontcg";
import { setKey, setsAgree } from "@/lib/setName";
import { normalizeForSearch } from "@/lib/text";
import type { DeckCardEntry } from "@/lib/types";

const CACHE_KEY = "ptcgo_set_codes";
const CACHE_TTL_MS = 7 * 86_400_000;

/** Basic energy the way Live writes it: symbol letter + the Scarlet &
 *  Violet energy set's numbering (Grass 1 … Metal 8). Fairy has no modern
 *  printing, so it exports as a plain named line and a warning. */
const BASIC_ENERGY: Record<string, { letter: string; number: number } | null> = {
  grass: { letter: "G", number: 1 },
  fire: { letter: "R", number: 2 },
  water: { letter: "W", number: 3 },
  lightning: { letter: "L", number: 4 },
  psychic: { letter: "P", number: 5 },
  fighting: { letter: "F", number: 6 },
  darkness: { letter: "D", number: 7 },
  metal: { letter: "M", number: 8 },
  fairy: null,
};
const BASIC_ENERGY_RE =
  /^(?:basic\s+)?(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i;
const ENERGY_SET_CODE = "SVE";

interface SetCodeMaps {
  byId: Map<string, string>;
  byName: Map<string, string>;
  /** For the loose pass: rows from the price sync carry TCGplayer-style
   *  names ("SFA: Shrouded Fable") that only setsAgree can connect. */
  sets: Array<{ name: string; code: string }>;
}

/** The PTCGO code list, cached for a week. Empty maps when it has never
 *  been fetchable — every line then degrades to a warning, not a failure. */
async function setCodeMaps(admin: SupabaseClient): Promise<SetCodeMaps> {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  type Cached = { at: number; sets: Array<{ id: string; name: string; code: string | null }> };
  let cached: Cached | null = null;
  try {
    const { data } = await admin
      .from("app_state")
      .select("value")
      .eq("key", CACHE_KEY)
      .maybeSingle();
    const v = data?.value as Cached | null;
    if (v && Array.isArray(v.sets) && typeof v.at === "number") cached = v;
  } catch {
    // No cache table (pre-022) — fetch fresh each time.
  }

  let sets = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.sets : null;
  if (!sets) {
    try {
      sets = await fetchSetCodes();
      await admin
        .from("app_state")
        .upsert({ key: CACHE_KEY, value: { at: Date.now(), sets } })
        .then(() => {});
    } catch {
      // Their API is down: a stale list is far better than none.
      sets = cached?.sets ?? [];
    }
  }
  const coded: SetCodeMaps["sets"] = [];
  for (const s of sets) {
    if (!s.code) continue;
    byId.set(s.id, s.code);
    coded.push({ name: s.name, code: s.code });
    const k = setKey(s.name);
    if (k && !byName.has(k)) byName.set(k, s.code);
  }
  return { byId, byName, sets: coded };
}

/** "034" → "34", "SWSH095" → "SWSH95" — Live writes numbers unpadded. */
function liveNumber(n: string | null | undefined): string {
  return (n ?? "").trim().replace(/^([^0-9]*)0+(?=\d)/, "$1");
}

/** Printing qualifiers are ours, not the card's — Live wants the name. */
function liveName(name: string): string {
  return name.replace(/\s*\(.+\)\s*$/, "").trim();
}

export interface LiveExport {
  text: string;
  /** Cards written without a set code — Live may not recognise the line. */
  warnings: string[];
}

export async function deckToLiveText(
  admin: SupabaseClient,
  entries: DeckCardEntry[]
): Promise<LiveExport> {
  const codes = await setCodeMaps(admin);
  const warnings: string[] = [];

  // Everything the lines need about the actual printings, in two batched
  // queries: the rows the deck references by id, and — for entries with no
  // id or an unresolvable set — every printing sharing the name, so a
  // printing whose set DOES resolve can stand in. Any real printing
  // imports; the reprint Live picks is the same card.
  type Row = { id: string; name: string; number: string; set_id: string; set_name: string };
  const rowsById = new Map<string, Row>();
  const rowsByKey = new Map<string, Row[]>();
  const ids = [...new Set(entries.map((e) => e.card_id).filter((v): v is string => !!v))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin
      .from("cards")
      .select("id, name, number, set_id, set_name")
      .in("id", ids.slice(i, i + 100));
    for (const r of (data ?? []) as Row[]) rowsById.set(r.id, r);
  }
  const nameKeys = [
    ...new Set(
      entries
        .filter((e) => !BASIC_ENERGY_RE.test(e.name.trim()))
        .map((e) => normalizeForSearch(e.name))
        .filter(Boolean)
    ),
  ];
  try {
    for (let i = 0; i < nameKeys.length; i += 100) {
      const { data } = await admin
        .from("cards")
        .select("id, name, number, set_id, set_name")
        .in("name_key", nameKeys.slice(i, i + 100))
        .limit(1000);
      for (const r of (data ?? []) as Row[]) {
        const k = normalizeForSearch(r.name);
        const list = rowsByKey.get(k);
        if (list) list.push(r);
        else rowsByKey.set(k, [r]);
      }
    }
  } catch {
    // Pre-066: no name_key column. The by-id rows carry what they can.
  }

  const codeFor = (row: Row): string | null =>
    codes.byId.get(row.set_id) ??
    codes.byName.get(setKey(row.set_name)) ??
    // Loose pass: same set under a different naming convention — an era
    // prefix, a dropped year. ~200 sets, a few dozen lookups; fine.
    codes.sets.find((s) => setsAgree(row.set_name, s.name))?.code ??
    null;

  const lineFor = (e: DeckCardEntry): string => {
    const basic = e.name.trim().match(BASIC_ENERGY_RE);
    if (basic) {
      const kind = BASIC_ENERGY[basic[1].toLowerCase()];
      if (kind) return `${e.quantity} Basic {${kind.letter}} Energy ${ENERGY_SET_CODE} ${kind.number}`;
      warnings.push(e.name);
      return `${e.quantity} ${liveName(e.name)}`;
    }
    // The referenced printing, if its set resolves; otherwise ANY printing
    // of the name whose set does; otherwise whatever we hold, code-less.
    let row = e.card_id ? (rowsById.get(e.card_id) ?? null) : null;
    let code = row ? codeFor(row) : null;
    if (!code) {
      const siblings = rowsByKey.get(normalizeForSearch(e.name)) ?? [];
      const coded = siblings.find((s) => codeFor(s) != null);
      if (coded) {
        row = coded;
        code = codeFor(coded);
      }
    }
    if (row && code) return `${e.quantity} ${liveName(row.name)} ${code} ${liveNumber(row.number)}`;
    warnings.push(e.name);
    return `${e.quantity} ${liveName(e.name)}`;
  };

  // Three buckets, and only three — an entry with a category the model
  // never labelled files under Trainer rather than vanishing.
  const buckets: Record<"pokemon" | "trainer" | "energy", DeckCardEntry[]> = {
    pokemon: [],
    trainer: [],
    energy: [],
  };
  for (const e of entries) {
    if (e.quantity <= 0) continue;
    const cat = e.category === "pokemon" || e.category === "energy" ? e.category : "trainer";
    buckets[cat].push(e);
  }
  const parts: string[] = [];
  for (const [title, list] of [
    ["Pokémon", buckets.pokemon],
    ["Trainer", buckets.trainer],
    ["Energy", buckets.energy],
  ] as const) {
    if (list.length === 0) continue;
    // The header counts LINES (distinct cards), not copies — verified
    // against a real Live export.
    parts.push(`${title}: ${list.length}`);
    parts.push(...list.map(lineFor), "");
  }
  const total = entries.reduce((s, e) => s + (e.quantity > 0 ? e.quantity : 0), 0);
  parts.push(`Total Cards: ${total}`);

  return { text: parts.join("\n"), warnings };
}
