"use client";

// Trending decks: the competitive meta, joined against what YOU own.
//
// Everything here comes from our own meta_decks table (nightly Limitless
// pull and/or admin curation) — the page never talks to an external API,
// and the interesting number on every tile is personal: how much of this
// deck is already in your binder, and what the gap costs.

import { useEffect, useState } from "react";
import CardZoom from "@/components/CardZoom";
import { money, moneyOrDash } from "@/lib/money";
import { shortAgo } from "@/lib/text";

interface MetaCard {
  name: string;
  count: number;
  category?: "pokemon" | "trainer" | "energy" | "commander" | "creature" | "spell" | "land";
  owned: number;
  price: number | null;
  image: string | null;
  imageLarge?: string | null;
  heldBy: Array<{ name: string; qty: number }>;
  buyUrl?: string;
}

interface MetaDeck {
  id: string;
  archetype: string;
  game?: "pokemon" | "mtg";
  format: string;
  share: number | null;
  placements: number | null;
  source: "curated" | "limitless" | "scryfall";
  windowDays: number | null;
  notes: string | null;
  updatedAt: string;
  cards: MetaCard[];
  ownedCount: number;
  totalCount: number;
  missingCount: number;
  missingCost: number;
  unpricedMissing: number;
}

const CATEGORY_ORDER: Record<string, number> = {
  commander: -1,
  pokemon: 0,
  creature: 0,
  trainer: 1,
  spell: 1,
  energy: 2,
  land: 2,
};

export default function MetaPage() {
  const [decks, setDecks] = useState<MetaDeck[]>([]);
  const [hasLimitless, setHasLimitless] = useState(false);
  const [affiliate, setAffiliate] = useState(false);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [gameTab, setGameTab] = useState<"pokemon" | "mtg">("pokemon");
  /** The card art being looked at full-screen, if any. */
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/meta");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Couldn't load the meta");
        setMigrated(json.migrated !== false);
        setDecks(json.decks ?? []);
        setHasLimitless(json.hasLimitless === true);
        setAffiliate(json.affiliate === true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load the meta");
      }
      setLoading(false);
    })();
  }, []);

  if (loading) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Trending decks</h1>
        <p className="text-sm text-slate-500">
          {gameTab === "mtg"
            ? "The most-built commanders across the community (EDHREC popularity via Scryfall), plus anything curated by hand — and how close your collection is to each."
            : "What's winning at real tournaments right now — and how close your collection already is to each one."}
        </p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* One page, two metas — same split as the collection tabs. */}
      <div className="flex gap-1 border-b border-slate-200">
        {(["pokemon", "mtg"] as const).map((g) => (
          <button
            key={g}
            onClick={() => {
              setGameTab(g);
              setExpanded(null);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${
              gameTab === g
                ? "border-brand-accent text-brand-accent"
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            {g === "pokemon" ? "⚡ Pokémon" : "🪄 Magic"}
          </button>
        ))}
      </div>

      {!migrated && (
        <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          The meta table hasn&apos;t been created yet — an admin needs to run migration 068.
        </div>
      )}

      {migrated && decks.filter((d) => (d.game ?? "pokemon") === gameTab).length === 0 && !error && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          {gameTab === "mtg"
            ? "No Magic decks yet. The nightly pull fills this with the community's most-built commanders; an admin can also curate full archetypes by hand."
            : "No archetypes yet. The nightly sync fills this in on its own; an admin can also add decks by hand from the Admin page."}
        </div>
      )}

      {decks.filter((d) => (d.game ?? "pokemon") === gameTab).map((d) => {
        const open = expanded === d.id;
        // A community-built commander row IS one card — coverage bars and
        // "missing 1 ≈ $0.00" arithmetic read as nonsense on it. It gets a
        // spotlight: the card, whether you hold it, what it costs if not.
        const spotlight = d.source === "scryfall" && d.totalCount === 1;
        const spotCard = spotlight ? d.cards[0] : null;
        const pct = d.totalCount > 0 ? Math.round((d.ownedCount / d.totalCount) * 100) : 0;
        const cards = [...d.cards].sort(
          (a, b) =>
            (CATEGORY_ORDER[a.category ?? "pokemon"] ?? 0) -
              (CATEGORY_ORDER[b.category ?? "pokemon"] ?? 0) || b.count - a.count
        );
        return (
          <div key={d.id} className="rounded-xl border border-slate-200 bg-white">
            <button
              className="flex w-full items-center gap-4 p-4 text-left"
              onClick={() => setExpanded(open ? null : d.id)}
            >
              {spotlight && spotCard?.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={spotCard.image}
                  alt=""
                  className="h-14 w-10 shrink-0 rounded object-cover"
                  loading="lazy"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-base font-semibold">{d.archetype}</span>
                  {d.share != null && (
                    <span className="text-sm text-slate-500">{d.share}% of top finishes</span>
                  )}
                  {d.placements != null && d.windowDays != null && (
                    <span className="text-xs text-slate-400">
                      {d.placements} top finishes · last {d.windowDays} days
                    </span>
                  )}
                  {/* Every row says where it came from. The pills began as
                      warnings on the NON-tournament sources, which left the
                      Limitless rows — the real thing — as the only ones with
                      no tag at all, reading as an inconsistency rather than
                      a default. */}
                  {d.source === "curated" && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                      curated
                    </span>
                  )}
                  {d.source === "scryfall" && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                      community-built
                    </span>
                  )}
                  {d.source === "limitless" && (
                    <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] text-green-700">
                      tournament results
                    </span>
                  )}
                </div>
                {spotlight ? (
                  <div className="mt-1 text-sm text-slate-600">
                    {d.notes}
                    <span className="ml-1 whitespace-nowrap">
                      {d.ownedCount > 0 ? (
                        <b className="text-green-700">· in your binder ✓</b>
                      ) : spotCard?.price != null ? (
                        <>· ≈ ${spotCard.price.toFixed(2)} to pick up</>
                      ) : null}
                    </span>
                  </div>
                ) : (
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-poke-blue"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm text-slate-600">
                    You own {d.ownedCount} of {d.totalCount}
                  </span>
                  {d.missingCount > 0 ? (
                    <span className="text-sm text-slate-500">
                      · missing {d.missingCount} ≈ {money(d.missingCost)}
                      {d.unpricedMissing > 0 && (
                        <span className="text-slate-400"> (+{d.unpricedMissing} unpriced)</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-sm font-medium text-green-700">· complete!</span>
                  )}
                </div>
                )}
              </div>
              <span className="shrink-0 text-slate-400">{open ? "▾" : "▸"}</span>
            </button>

            {open && (
              <div className="border-t border-slate-100 p-4">
                {/* Spotlight rows already carry their notes in the header —
                    repeating them here read as a rendering bug. */}
                {d.notes && !spotlight && (
                  <p className="mb-3 text-sm text-slate-500">{d.notes}</p>
                )}
                <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {cards.map((c, i) => {
                    const gap = c.count - c.owned;
                    return (
                      <li key={i} className="flex items-center gap-2 text-sm">
                        {/* The art, tappable — a thumbnail is enough to tell
                            cards apart; the zoom is for actually reading one. */}
                        {c.image ? (
                          <button
                            type="button"
                            className="shrink-0 cursor-zoom-in"
                            onClick={() =>
                              setZoom({ src: c.imageLarge ?? c.image!, alt: c.name })
                            }
                            aria-label={`See ${c.name} larger`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={c.image}
                              alt=""
                              className="h-12 w-9 rounded object-cover"
                              loading="lazy"
                            />
                          </button>
                        ) : (
                          <span className="flex h-12 w-9 shrink-0 items-center justify-center rounded bg-slate-100 text-xs text-slate-300">
                            🂠
                          </span>
                        )}
                        <span className="w-7 shrink-0 text-right font-mono text-slate-400">
                          {c.count}×
                        </span>
                        <span className={gap === 0 ? "text-slate-400 line-through decoration-slate-300" : ""}>
                          {c.name}
                        </span>
                        {gap === 0 ? (
                          <span className="text-xs text-green-700">✓ own {c.owned}</span>
                        ) : (
                          <span className="text-xs text-slate-500">
                            {c.owned > 0 ? `own ${c.owned}, ` : ""}need {gap}
                            {c.price != null && <> · {moneyOrDash(c.price)} ea</>}
                          </span>
                        )}
                        {c.heldBy.length > 0 && gap > 0 && (
                          <span className="text-xs text-poke-blue">
                            {c.heldBy.map((h) => `${h.name} has ${h.qty}`).join(", ")}
                          </span>
                        )}
                        {c.buyUrl && gap > 0 && (
                          <a
                            href={c.buyUrl}
                            target="_blank"
                            rel="noreferrer sponsored"
                            className="text-xs font-semibold text-amber-700 hover:underline"
                          >
                            buy ↗
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="m-0 text-xs text-slate-400">
                    Updated {shortAgo(d.updatedAt)}
                    {d.source === "limitless" && " · results via LimitlessTCG"}
                    {d.source === "scryfall" && " · popularity and card picks via EDHREC"}
                  </p>
                  <a
                    className="btn-secondary shrink-0 text-sm"
                    href={`/decks?pool=all&archetype=${encodeURIComponent(d.archetype)}${
                      (d.game ?? "pokemon") === "mtg"
                        ? `&game=mtg&format=${encodeURIComponent(d.format)}`
                        : ""
                    }`}
                  >
                    Build this deck
                  </a>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {(hasLimitless || affiliate) && (
        <p className="text-center text-xs text-slate-400">
          {hasLimitless && (
            <>
              Tournament data via{" "}
              <a
                href="https://limitlesstcg.com"
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                LimitlessTCG
              </a>
              .
            </>
          )}
          {affiliate && (
            <>
              {" "}
              TCGdeck earns a small commission on TCGplayer purchases made through buy
              links — at no extra cost to you.
            </>
          )}
        </p>
      )}

      {zoom && <CardZoom src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </div>
  );
}
