// Nightly pull of the competitive meta from LimitlessTCG.
//
// Their public API is pull-based and keyless at our volume: one client, a
// handful of requests, once a day. (An access key only raises rate limits
// and unlocks organizer endpoints — if LIMITLESS_API_KEY is ever set in the
// environment it is sent, but nothing here requires it.) Members never call
// Limitless: this loop aggregates recent tournament standings into
// meta_decks and everyone reads our table.
//
// DEFENSIVE ON PURPOSE. The response shapes below are what their API serves
// today, and none of it is under our control. Every read is optional-
// chained, anything that doesn't parse is skipped, and a run that can't
// produce a sane result leaves the table exactly as it was — curated rows
// are never touched at all, so the page keeps working on admin data however
// the feed misbehaves.

import { createAdminClient } from "@/lib/supabase/admin";
import type { MetaCoreCard } from "@/lib/meta";

const STATE_KEY = "meta_sync";
const API = "https://play.limitlesstcg.com/api";
/** How far back counts as "the current meta". */
const WINDOW_DAYS = 30;
/** Standings deep enough to mean something, shallow enough to stay "top". */
const TOP_PLACINGS = 16;
/** Tournaments read per run — newest first, politely. */
const MAX_TOURNAMENTS = 20;
/** An archetype seen fewer times than this is noise, not a trend. */
const MIN_PLACEMENTS = 3;
/** Rows the table keeps per format. */
const MAX_ARCHETYPES = 12;

async function limitlessJson(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "TrainerDeck meta sync (trainerdeck.io)",
  };
  if (process.env.LIMITLESS_API_KEY) headers["x-access-key"] = process.env.LIMITLESS_API_KEY;
  const res = await fetch(`${API}${path}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Limitless ${path} → ${res.status}`);
  return res.json();
}

interface Standing {
  placing: number;
  archetype: string;
  decklist: MetaCoreCard[] | null;
}

/** One tournament's top standings, in whatever of the known shapes it uses. */
function parseStandings(raw: unknown): Standing[] {
  if (!Array.isArray(raw)) return [];
  const out: Standing[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const placing = typeof r.placing === "number" ? r.placing : Number(r.placing);
    if (!Number.isFinite(placing) || placing < 1 || placing > TOP_PLACINGS) continue;
    // The archetype label Limitless assigns to the list.
    const deck = r.deck as { name?: unknown } | null | undefined;
    const archetype =
      typeof deck?.name === "string" && deck.name.trim() ? deck.name.trim() : null;
    if (!archetype || archetype.length > 80) continue;
    out.push({ placing, archetype, decklist: parseDecklist(r.decklist) });
  }
  return out;
}

/** {pokemon:[{name,count}...], trainer:[...], energy:[...]} → flat cards. */
function parseDecklist(raw: unknown): MetaCoreCard[] | null {
  if (!raw || typeof raw !== "object") return null;
  const sections: Array<[MetaCoreCard["category"], unknown]> = [
    ["pokemon", (raw as Record<string, unknown>).pokemon],
    ["trainer", (raw as Record<string, unknown>).trainer],
    ["energy", (raw as Record<string, unknown>).energy],
  ];
  const cards: MetaCoreCard[] = [];
  for (const [category, list] of sections) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { name?: unknown; count?: unknown };
      const name = typeof e?.name === "string" ? e.name.trim() : "";
      const count = typeof e?.count === "number" ? e.count : Number(e?.count);
      if (!name || !Number.isFinite(count) || count < 1 || count > 60) continue;
      cards.push({ name, count, category });
    }
  }
  // A legal list is 60 cards; anything wildly off is a parse gone wrong,
  // and wrong cards are worse than no cards.
  const total = cards.reduce((s, c) => s + c.count, 0);
  return total >= 40 && total <= 70 ? cards : null;
}

/** Pull, aggregate, and store. Returns a one-line human summary. */
export async function syncMeta(): Promise<string> {
  const admin = createAdminClient();

  const rawList = await limitlessJson(`/tournaments?game=PTCG&limit=100`);
  if (!Array.isArray(rawList)) throw new Error("tournament list: unexpected shape");
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const recent = rawList
    .map((t) => t as Record<string, unknown>)
    .filter((t) => {
      const when = Date.parse((t.date as string) ?? "");
      const format = String(t.format ?? "").toLowerCase();
      return (
        typeof t.id === "string" &&
        Number.isFinite(when) &&
        when >= cutoff &&
        (format === "" || format === "standard")
      );
    })
    .slice(0, MAX_TOURNAMENTS);
  if (recent.length === 0) return "meta sync: no recent standard tournaments in the feed";

  // Count top finishes per archetype; keep the best-placed decklist as the
  // archetype's core list.
  const byArchetype = new Map<
    string,
    { archetype: string; placements: number; bestPlacing: number; cards: MetaCoreCard[] | null }
  >();
  let counted = 0;
  for (const t of recent) {
    let standings: Standing[];
    try {
      standings = parseStandings(await limitlessJson(`/tournaments/${t.id}/standings`));
    } catch {
      continue; // one broken tournament never sinks the run
    }
    for (const s of standings) {
      counted += 1;
      const key = s.archetype.toLowerCase();
      const agg = byArchetype.get(key) ?? {
        archetype: s.archetype,
        placements: 0,
        bestPlacing: Number.MAX_SAFE_INTEGER,
        cards: null,
      };
      agg.placements += 1;
      if (s.decklist && s.placing < agg.bestPlacing) {
        agg.bestPlacing = s.placing;
        agg.cards = s.decklist;
      }
      byArchetype.set(key, agg);
    }
    // A breath between tournaments: their favour, our manners.
    await new Promise((r) => setTimeout(r, 500));
  }
  if (counted === 0) throw new Error("standings: nothing parsed from any tournament");

  const ranked = [...byArchetype.values()]
    .filter((a) => a.placements >= MIN_PLACEMENTS && a.cards != null)
    .sort((a, b) => b.placements - a.placements)
    .slice(0, MAX_ARCHETYPES);
  if (ranked.length === 0) throw new Error("standings parsed but no archetype cleared the floor");

  // Curated rows are the admin's word — the sync never writes over one.
  const { data: existing, error: readErr } = await admin
    .from("meta_decks")
    .select("id, archetype, source")
    .eq("format", "standard");
  if (readErr) throw readErr;
  const curated = new Set(
    (existing ?? [])
      .filter((r) => r.source === "curated")
      .map((r) => (r.archetype as string).toLowerCase())
  );
  const limitlessByName = new Map(
    (existing ?? [])
      .filter((r) => r.source === "limitless")
      .map((r) => [(r.archetype as string).toLowerCase(), r.id as string])
  );

  const now = new Date().toISOString();
  let wrote = 0;
  const keep = new Set<string>();
  for (const a of ranked) {
    const key = a.archetype.toLowerCase();
    if (curated.has(key)) continue;
    keep.add(key);
    const row = {
      archetype: a.archetype,
      format: "standard",
      share: Math.round((a.placements / counted) * 1000) / 10,
      placements: a.placements,
      core_cards: a.cards,
      source: "limitless",
      window_days: WINDOW_DAYS,
      updated_at: now,
    };
    const id = limitlessByName.get(key);
    const { error } = id
      ? await admin.from("meta_decks").update(row).eq("id", id)
      : await admin.from("meta_decks").insert(row);
    if (!error) wrote += 1;
  }
  // Archetypes that fell out of the meta leave the table with it.
  const stale = [...limitlessByName.entries()].filter(([k]) => !keep.has(k)).map(([, id]) => id);
  if (stale.length > 0) {
    await admin.from("meta_decks").delete().in("id", stale).then(() => {});
  }

  return (
    `meta sync: ${recent.length} tournaments, ${counted} top finishes → ` +
    `${wrote} archetypes written${stale.length ? `, ${stale.length} rotated out` : ""}`
  );
}

/** Daily loop, same claim discipline as the price refresh: the app_state
 *  row is the inter-instance lock, claimed only when stale. */
export function startMetaSyncLoop() {
  const tick = async () => {
    try {
      const admin = createAdminClient();
      const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
      await admin
        .from("app_state")
        .upsert({ key: STATE_KEY }, { onConflict: "key", ignoreDuplicates: true })
        .then(() => {});
      const { data: claimed, error } = await admin
        .from("app_state")
        .update({ updated_at: new Date().toISOString() })
        .eq("key", STATE_KEY)
        .lt("updated_at", cutoff)
        .select("key");
      if (error || !claimed || claimed.length === 0) return;
      try {
        console.log(await syncMeta());
      } catch (err) {
        // The table keeps whatever it had; say why tonight added nothing.
        console.log(
          `meta sync: skipped (${err instanceof Error ? err.message : String(err)}) — ` +
            `curated/previous rows stand, retrying tomorrow`
        );
      }
    } catch (err) {
      console.error("meta sync loop error", err);
    }
  };
  // A few minutes after boot, then hourly checks against the daily claim.
  setTimeout(tick, 5 * 60_000);
  setInterval(tick, 3600_000);
}
