"use client";

// Trending decks: the competitive meta, joined against what YOU own.
//
// Everything here comes from our own meta_decks table (nightly Limitless
// pull and/or admin curation) — the page never talks to an external API,
// and the interesting number on every tile is personal: how much of this
// deck is already in your binder, and what the gap costs.

import { useEffect, useState } from "react";
import { money, moneyOrDash } from "@/lib/money";
import { shortAgo } from "@/lib/text";

interface MetaCard {
  name: string;
  count: number;
  category?: "pokemon" | "trainer" | "energy";
  owned: number;
  price: number | null;
  image: string | null;
  heldBy: Array<{ name: string; qty: number }>;
  buyUrl?: string;
}

interface MetaDeck {
  id: string;
  archetype: string;
  format: string;
  share: number | null;
  placements: number | null;
  source: "curated" | "limitless";
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

const CATEGORY_ORDER: Record<string, number> = { pokemon: 0, trainer: 1, energy: 2 };

export default function MetaPage() {
  const [decks, setDecks] = useState<MetaDeck[]>([]);
  const [hasLimitless, setHasLimitless] = useState(false);
  const [affiliate, setAffiliate] = useState(false);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
          What&apos;s winning at real tournaments right now — and how close your collection
          already is to each one.
        </p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {!migrated && (
        <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          The meta table hasn&apos;t been created yet — an admin needs to run migration 068.
        </div>
      )}

      {migrated && decks.length === 0 && !error && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No archetypes yet. The nightly sync fills this in on its own; an admin can also add
          decks by hand from the Admin page.
        </div>
      )}

      {decks.map((d) => {
        const open = expanded === d.id;
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
                  {d.source === "curated" && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                      curated
                    </span>
                  )}
                </div>
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
              </div>
              <span className="shrink-0 text-slate-400">{open ? "▾" : "▸"}</span>
            </button>

            {open && (
              <div className="border-t border-slate-100 p-4">
                {d.notes && <p className="mb-3 text-sm text-slate-500">{d.notes}</p>}
                <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {cards.map((c, i) => {
                    const gap = c.count - c.owned;
                    return (
                      <li key={i} className="flex items-baseline gap-2 text-sm">
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
                  </p>
                  <a
                    className="btn-secondary shrink-0 text-sm"
                    href={`/decks?pool=all&archetype=${encodeURIComponent(d.archetype)}`}
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
              TrainerDeck earns a small commission on TCGplayer purchases made through buy
              links — at no extra cost to you.
            </>
          )}
        </p>
      )}
    </div>
  );
}
