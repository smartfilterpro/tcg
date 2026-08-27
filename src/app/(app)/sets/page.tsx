"use client";

// Set completion — the collector's core loop, answered per set: how far
// along am I, what exactly is missing, and what would finishing cost.
// Reads only what the app already holds (plus free Scryfall completion for
// Magic sets), so browsing here never spends a credit.

import { useEffect, useState } from "react";
import { photoSrc } from "@/lib/art";

interface SetSummary {
  name: string;
  game: "pokemon" | "mtg";
  code: string | null;
  owned: number;
  total: number | null;
  pct: number | null;
}

interface SetCardEntry {
  number: string;
  name: string;
  price: number | null;
  image: string | null;
  owned: boolean;
  buyUrl?: string;
}

interface SetDetail {
  cards: SetCardEntry[];
  missingCost: number;
  unpriced: number;
  catalogued: number;
  external: boolean;
}

export default function SetsPage() {
  const [sets, setSets] = useState<SetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gameTab, setGameTab] = useState<"pokemon" | "mtg">("pokemon");
  const [openSet, setOpenSet] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, SetDetail | "loading">>({});
  /** Missing-only is the default — it is the question this page answers. */
  const [showOwned, setShowOwned] = useState(false);

  useEffect(() => {
    fetch("/api/sets")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setSets(j.sets ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your sets"));
  }, []);

  async function toggle(s: SetSummary) {
    const key = `${s.game}|${s.name}`;
    if (openSet === key) {
      setOpenSet(null);
      return;
    }
    setOpenSet(key);
    if (detail[key]) return;
    setDetail((d) => ({ ...d, [key]: "loading" }));
    try {
      const params = new URLSearchParams({ set: s.name, game: s.game });
      if (s.code) params.set("code", s.code);
      const res = await fetch(`/api/sets/cards?${params}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't list that set");
      setDetail((d) => ({ ...d, [key]: j as SetDetail }));
    } catch {
      setDetail((d) => {
        const { [key]: _drop, ...rest } = d;
        return rest;
      });
      setOpenSet(null);
    }
  }

  const shown = (sets ?? []).filter((s) => s.game === gameTab);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Set progress</h1>
        <p className="text-sm text-slate-500">
          Every set you&apos;ve started, how close it is to done, and exactly what finishing it
          would take.
        </p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="flex gap-1 border-b border-slate-200">
        {(["pokemon", "mtg"] as const).map((g) => (
          <button
            key={g}
            onClick={() => {
              setGameTab(g);
              setOpenSet(null);
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

      {sets === null && !error && <p className="text-sm text-slate-400">Adding up your sets…</p>}

      {sets !== null && shown.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No {gameTab === "mtg" ? "Magic" : "Pokémon"} sets started yet — scan some cards and
          they&apos;ll appear here, set by set.
        </div>
      )}

      {shown.map((s) => {
        const key = `${s.game}|${s.name}`;
        const open = openSet === key;
        const d = detail[key];
        return (
          <div key={key} className="rounded-xl border border-slate-200 bg-white">
            <button className="flex w-full items-center gap-4 p-4 text-left" onClick={() => toggle(s)}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-base font-semibold">{s.name}</span>
                  {s.pct === 100 && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                      complete!
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${s.pct === 100 ? "bg-green-500" : "bg-poke-blue"}`}
                      style={{ width: `${s.pct ?? 0}%` }}
                    />
                  </div>
                  <span className="text-sm text-slate-600">
                    {s.owned}
                    {s.total != null ? ` of ${s.total}` : " cards"}
                    {s.pct != null && ` · ${s.pct}%`}
                  </span>
                </div>
              </div>
              <span className="shrink-0 text-slate-400">{open ? "▾" : "▸"}</span>
            </button>

            {open && (
              <div className="border-t border-slate-100 p-4">
                {d === "loading" || d == null ? (
                  <p className="text-sm text-slate-400">Checking the set list…</p>
                ) : (
                  <>
                    {(() => {
                      const missing = d.cards.filter((c) => !c.owned);
                      const list = showOwned ? d.cards : missing;
                      return (
                        <>
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span className="text-slate-600">
                              {missing.length === 0 ? (
                                <b className="text-green-700">Nothing missing — set complete 🎉</b>
                              ) : (
                                <>
                                  Missing {missing.length} · finishing ≈{" "}
                                  <b>
                                    $
                                    {d.missingCost.toLocaleString(undefined, {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}
                                  </b>
                                  {d.unpriced > 0 && (
                                    <span className="text-slate-400"> (+{d.unpriced} unpriced)</span>
                                  )}
                                </>
                              )}
                            </span>
                            <label className="flex items-center gap-1.5 text-xs text-slate-500">
                              <input
                                type="checkbox"
                                checked={showOwned}
                                onChange={(e) => setShowOwned(e.target.checked)}
                              />
                              show owned too
                            </label>
                          </div>
                          {list.length === 0 ? (
                            <p className="text-sm text-slate-400">Nothing to show.</p>
                          ) : (
                            <ul className="max-h-96 space-y-1 overflow-y-auto">
                              {list.map((c) => (
                                <li
                                  key={c.number}
                                  className={`flex items-center gap-2 rounded p-1 text-sm ${
                                    c.owned ? "opacity-50" : ""
                                  }`}
                                >
                                  <div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-slate-100">
                                    {c.image && (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={photoSrc(c.image) ?? c.image}
                                        alt=""
                                        className="h-full w-full object-cover"
                                        loading="lazy"
                                      />
                                    )}
                                  </div>
                                  <span className="w-12 shrink-0 font-mono text-xs text-slate-400">
                                    #{c.number}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate">
                                    {c.name || <i className="text-slate-400">(uncatalogued)</i>}
                                    {c.owned && " ✓"}
                                  </span>
                                  {c.price != null && (
                                    <span className="shrink-0 font-mono text-xs text-slate-500">
                                      ${c.price.toFixed(2)}
                                    </span>
                                  )}
                                  {!c.owned && c.buyUrl && (
                                    <a
                                      className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-brand-accent hover:bg-slate-200"
                                      href={c.buyUrl}
                                      target="_blank"
                                      rel="noreferrer sponsored"
                                    >
                                      Buy
                                    </a>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          {/* Honesty note: a list can only be as complete as its
                              sources, and a thin one should say so instead of
                              passing as the whole set. */}
                          {s.total != null && d.catalogued < s.total && (
                            <p className="mt-2 text-xs text-slate-400">
                              {d.catalogued} of this set&apos;s ~{s.total} cards are catalogued so
                              far — the missing list grows as the catalogue does.
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
