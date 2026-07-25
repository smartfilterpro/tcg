"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CollectionItem } from "@/lib/types";

type SortKey = "newest" | "name" | "price" | "set";

export default function CollectionPage() {
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [setFilter, setSetFilter] = useState("");
  const [rarityFilter, setRarityFilter] = useState("");
  const [supertypeFilter, setSupertypeFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [selected, setSelected] = useState<CollectionItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/collection");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setItems(json.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collection");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const facets = useMemo(() => {
    const sets = new Map<string, string>();
    const types = new Set<string>();
    const rarities = new Set<string>();
    const supertypes = new Set<string>();
    for (const item of items ?? []) {
      const c = item.card;
      if (!c) continue;
      sets.set(c.set_id, c.set_name);
      for (const t of c.types ?? []) types.add(t);
      if (c.rarity) rarities.add(c.rarity);
      if (c.supertype) supertypes.add(c.supertype);
    }
    return {
      sets: [...sets.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      types: [...types].sort(),
      rarities: [...rarities].sort(),
      supertypes: [...supertypes].sort(),
    };
  }, [items]);

  const filtered = useMemo(() => {
    let list = (items ?? []).filter((i) => i.card);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((i) => i.card.name.toLowerCase().includes(q));
    if (typeFilter) list = list.filter((i) => (i.card.types ?? []).includes(typeFilter));
    if (setFilter) list = list.filter((i) => i.card.set_id === setFilter);
    if (rarityFilter) list = list.filter((i) => i.card.rarity === rarityFilter);
    if (supertypeFilter) list = list.filter((i) => i.card.supertype === supertypeFilter);
    switch (sort) {
      case "name":
        list = [...list].sort((a, b) => a.card.name.localeCompare(b.card.name));
        break;
      case "price":
        list = [...list].sort(
          (a, b) => (b.card.market_price ?? 0) - (a.card.market_price ?? 0)
        );
        break;
      case "set":
        list = [...list].sort(
          (a, b) =>
            a.card.set_name.localeCompare(b.card.set_name) ||
            (parseInt(a.card.number) || 0) - (parseInt(b.card.number) || 0)
        );
        break;
    }
    return list;
  }, [items, search, typeFilter, setFilter, rarityFilter, supertypeFilter, sort]);

  const totals = useMemo(() => {
    const all = (items ?? []).filter((i) => i.card);
    return {
      cards: all.reduce((s, i) => s + i.quantity, 0),
      unique: all.length,
      value: all.reduce((s, i) => s + (i.card.market_price ?? 0) * i.quantity, 0),
    };
  }, [items]);

  async function updateQuantity(item: CollectionItem, quantity: number) {
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
    if (res.ok) {
      setItems(
        (prev) =>
          prev
            ?.map((i) => (i.id === item.id ? { ...i, quantity } : i))
            .filter((i) => i.quantity > 0) ?? null
      );
      if (quantity === 0) setSelected(null);
      else setSelected((s) => (s?.id === item.id ? { ...s, quantity } : s));
    }
  }

  async function refreshPrices() {
    setRefreshing(true);
    try {
      await fetch("/api/collection/refresh-prices", { method: "POST" });
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  if (error) return <p className="text-red-600">{error}</p>;
  if (!items) return <p className="text-slate-500">Loading your collection…</p>;

  if (items.length === 0) {
    return (
      <div className="card-panel mx-auto mt-12 max-w-md p-8 text-center">
        <div className="text-4xl">📷</div>
        <h1 className="mt-2 text-xl font-bold">Your collection is empty</h1>
        <p className="mt-1 text-sm text-slate-500">
          Scan your first cards to start building your collection.
        </p>
        <Link href="/scan" className="btn-primary mt-4">
          Scan cards
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">My Collection</h1>
          <p className="text-sm text-slate-500">
            {totals.cards} cards · {totals.unique} unique ·{" "}
            <span className="font-semibold text-green-700">
              ~${totals.value.toFixed(2)} value
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={refreshPrices} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "↻ Refresh prices"}
          </button>
          <Link href="/scan" className="btn-primary">
            + Scan cards
          </Link>
        </div>
      </div>

      <div className="card-panel mb-4 flex flex-wrap gap-2 p-3">
        <input
          className="input max-w-56 flex-1"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input w-auto" value={supertypeFilter} onChange={(e) => setSupertypeFilter(e.target.value)}>
          <option value="">All card types</option>
          {facets.supertypes.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select className="input w-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All energy types</option>
          {facets.types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select className="input w-auto max-w-48" value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
          <option value="">All sets</option>
          {facets.sets.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select className="input w-auto max-w-52" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
          <option value="">All rarities</option>
          {facets.rarities.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="newest">Newest first</option>
          <option value="name">Name A–Z</option>
          <option value="price">Highest value</option>
          <option value="set">By set</option>
        </select>
      </div>

      <p className="mb-2 text-xs text-slate-400">{filtered.length} shown</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {filtered.map((item) => (
          <button
            key={item.id}
            className="card-panel group relative overflow-hidden p-2 text-left transition-transform hover:-translate-y-0.5 hover:shadow-md"
            onClick={() => setSelected(item)}
          >
            {item.quantity > 1 && (
              <span className="absolute right-2 top-2 z-10 rounded-full bg-poke-dark px-2 py-0.5 text-xs font-bold text-white">
                ×{item.quantity}
              </span>
            )}
            {item.card.image_small ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.card.image_small}
                alt={item.card.name}
                className="w-full rounded"
                loading="lazy"
              />
            ) : (
              <div className="flex aspect-[63/88] items-center justify-center rounded bg-slate-100 text-xs text-slate-400">
                No image
              </div>
            )}
            <div className="mt-2 truncate text-sm font-semibold">{item.card.name}</div>
            <div className="truncate text-xs text-slate-500">
              {item.card.set_name} · #{item.card.number}
            </div>
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="truncate text-slate-400">{item.card.rarity ?? ""}</span>
              {item.card.market_price != null && (
                <span className="font-semibold text-green-700">
                  ${item.card.market_price.toFixed(2)}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="card-panel max-h-[90vh] w-full max-w-md overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex gap-4">
              {selected.card.image_large || selected.card.image_small ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.card.image_large ?? selected.card.image_small!}
                  alt={selected.card.name}
                  className="w-40 rounded-lg shadow"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold">{selected.card.name}</h2>
                <dl className="mt-2 space-y-1 text-sm text-slate-600">
                  <div>Set: <span className="font-medium">{selected.card.set_name}</span></div>
                  <div>Number: #{selected.card.number}{selected.card.set_printed_total ? `/${selected.card.set_printed_total}` : ""}</div>
                  {selected.card.rarity && <div>Rarity: {selected.card.rarity}</div>}
                  {selected.card.supertype && <div>Card type: {selected.card.supertype}</div>}
                  {(selected.card.types ?? []).length > 0 && (
                    <div>Type: {(selected.card.types ?? []).join(", ")}</div>
                  )}
                  {selected.card.hp && <div>HP: {selected.card.hp}</div>}
                  {selected.card.market_price != null && (
                    <div className="font-semibold text-green-700">
                      Market: ${selected.card.market_price.toFixed(2)} each
                    </div>
                  )}
                </dl>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
              <div className="flex items-center gap-2">
                <button
                  className="btn-secondary h-9 w-9 p-0"
                  onClick={() => updateQuantity(selected, selected.quantity - 1)}
                >
                  −
                </button>
                <span className="w-10 text-center font-bold">{selected.quantity}</span>
                <button
                  className="btn-secondary h-9 w-9 p-0"
                  onClick={() => updateQuantity(selected, selected.quantity + 1)}
                >
                  +
                </button>
              </div>
              <button
                className="btn text-sm text-red-600 hover:bg-red-50"
                onClick={() => updateQuantity(selected, 0)}
              >
                Remove all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
