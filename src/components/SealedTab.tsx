"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SEALED_KINDS,
  sealedKindLabel,
  sealedItemPrice,
  type SealedItem,
  type SealedSuggestion,
} from "@/lib/sealed";

/** Sealed product in the collection — booster boxes, ETBs, tins.
 *
 *  Its own tab and its own tables, so nothing card-shaped has to learn about
 *  it: a booster box can never wander into a deck list, a grade report or a
 *  set-completion count, because none of those read this data at all.
 *
 *  The total is shown separately from the card total for the same reason.
 *  Mixing them would answer "what are my cards worth?" with a number that
 *  includes four sealed boxes, and that is a different question. */
export default function SealedTab() {
  const [items, setItems] = useState<SealedItem[] | null>(null);
  const [migrated, setMigrated] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("booster_box");
  const [productSet, setProductSet] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState("sealed");
  const [adding, setAdding] = useState(false);
  const [suggestions, setSuggestions] = useState<SealedSuggestion[]>([]);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sealed");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't load sealed product");
      setMigrated(json.migrated !== false);
      setItems(json.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load sealed product");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Suggestions while typing. Debounced, because every keystroke firing a
  // query is a query per keystroke, and the answer for "surg" is thrown
  // away the moment "surgi" is typed.
  useEffect(() => {
    if (!showAdd) return;
    let live = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sealed/search?q=${encodeURIComponent(name)}`);
        const json = await res.json();
        if (live && res.ok) setSuggestions(json.suggestions ?? []);
      } catch {
        // Suggestions are a convenience — typing a name still works.
      }
      if (live) setSearching(false);
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [name, showAdd]);

  async function add(pick?: SealedSuggestion) {
    const chosenName = (pick?.name ?? name).trim();
    if (!chosenName || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/sealed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: chosenName,
          kind: pick?.kind ?? kind,
          setName: pick?.setName ?? productSet,
          year: pick?.year ?? undefined,
          tcgPlayerId: pick?.tcgPlayerId ?? undefined,
          quantity,
          condition,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't add that");
      setName("");
      setProductSet("");
      setQuantity(1);
      setShowAdd(false);
      setNote("Added. Looking up a value in the background…");
      await load();
      // The price lands a moment after the row does; a single re-read a few
      // seconds later saves everyone pressing refresh to see it.
      setTimeout(load, 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that");
    }
    setAdding(false);
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusyId(id);
    setNote(null);
    try {
      const res = await fetch(`/api/sealed/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't save that");
      if (json.message) setNote(json.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that");
    }
    setBusyId(null);
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Remove ${label} from your collection?`)) return;
    setBusyId(id);
    try {
      await fetch(`/api/sealed/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (!migrated) {
    return (
      <p className="text-sm text-slate-500">
        Sealed product isn&apos;t set up yet — run{" "}
        <code className="text-xs">supabase/migrations/045_sealed_product.sql</code>.
      </p>
    );
  }
  if (error && !items) return <p className="text-red-600">{error}</p>;
  if (!items) return <p className="text-slate-500">Loading…</p>;

  const total = items.reduce((sum, i) => sum + (sealedItemPrice(i) ?? 0) * i.quantity, 0);
  const priced = items.filter((i) => sealedItemPrice(i) != null).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600">
          {items.length === 0 ? (
            "Nothing sealed yet."
          ) : (
            <>
              <b>{items.reduce((n, i) => n + i.quantity, 0)}</b> item
              {items.reduce((n, i) => n + i.quantity, 0) === 1 ? "" : "s"} ·{" "}
              <b className="text-green-700">${total.toFixed(2)}</b>
              {priced < items.length && (
                <span className="text-slate-400">
                  {" "}
                  ({items.length - priced} without a value)
                </span>
              )}
            </>
          )}
        </div>
        <button className="btn-primary text-sm" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add sealed product"}
        </button>
      </div>

      {note && <p className="m-0 text-xs text-slate-500">{note}</p>}
      {error && <p className="m-0 text-xs text-red-600">{error}</p>}

      {showAdd && (
        <div className="card-panel space-y-2 p-3">
          <input
            className="input w-full text-sm"
            placeholder="Search a set or product — e.g. Surging Sparks"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          {/* Quantity and condition are chosen BEFORE picking, because a
              suggestion adds in one tap and there is no second step to set
              them in. */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input w-auto text-sm"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            >
              <option value="sealed">Sealed</option>
              <option value="opened">Opened</option>
              <option value="damaged">Damaged</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-500">
              Qty
              <input
                className="input w-16 text-sm"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value) || 1)}
              />
            </label>
            {searching && <span className="text-[11px] text-slate-400">Searching…</span>}
          </div>

          {suggestions.length > 0 && (
            <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
              {suggestions.map((sug) => (
                <button
                  key={`${sug.source}|${sug.name}`}
                  className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-slate-50"
                  disabled={adding}
                  onClick={() => add(sug)}
                >
                  {sug.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sug.image}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-slate-100 text-sm">
                      📦
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{sug.name}</span>
                    <span className="block text-[11px] text-slate-400">
                      {sug.kindLabel}
                      {sug.year ? ` · ${sug.year}` : ""}
                      {/* The three sources mean different things and the
                          difference is worth showing: one joins an existing
                          product, one is a real product from the price
                          database, and one is a name we built that may not
                          name anything at all. */}
                      {sug.source === "catalogue"
                        ? " · already in your catalogue"
                        : sug.source === "tracker"
                          ? " · product database"
                          : " · suggested name"}
                      {sug.marketPrice != null ? ` · $${sug.marketPrice.toFixed(2)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-brand-accent">Add</span>
                </button>
              ))}
            </div>
          )}

          {/* The escape hatch. Japanese product, older boxes and promo tins
              won't be in any suggestion list, and refusing to accept a name
              nobody suggested would make those impossible to record. */}
          {name.trim().length > 2 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">Not listed? Add it by hand</summary>
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <select
                    className="input w-auto flex-1 text-sm"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    {SEALED_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {sealedKindLabel(k)}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input w-auto flex-1 text-sm"
                    placeholder="Set (optional)"
                    value={productSet}
                    onChange={(e) => setProductSet(e.target.value)}
                  />
                </div>
                <button
                  className="btn-primary text-sm"
                  disabled={adding}
                  onClick={() => add()}
                >
                  {adding ? "Adding…" : `Add "${name.trim()}"`}
                </button>
              </div>
            </details>
          )}

          <p className="m-0 text-[11px] text-slate-400">
            A value is looked up from current sealed listings after you add.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => {
            const price = sealedItemPrice(item);
            return (
              <div
                key={item.id}
                className="card-panel flex flex-wrap items-center gap-3 p-3 text-sm"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {item.product?.image_url ? (
                  <img
                    src={item.product.image_url}
                    alt=""
                    className="h-16 w-16 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-slate-100 text-lg">
                    📦
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{item.product?.name}</div>
                  <div className="text-xs text-slate-500">
                    {sealedKindLabel(item.product?.kind ?? "other")}
                    {item.product?.set_name ? ` · ${item.product.set_name}` : ""}
                    {item.condition !== "sealed" ? ` · ${item.condition}` : ""}
                  </div>
                  <div className="text-xs">
                    {price != null ? (
                      <span className="font-semibold text-green-700">
                        ${price.toFixed(2)} each
                        {item.price_override != null && (
                          <span className="font-normal text-slate-400"> (your value)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-slate-400">No value yet</span>
                    )}
                    {item.product?.price_source && item.price_override == null && (
                      <span className="text-slate-400"> · {item.product.price_source}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    className="btn-secondary h-8 w-8 p-0"
                    disabled={busyId === item.id || item.quantity <= 1}
                    onClick={() => patch(item.id, { quantity: item.quantity - 1 })}
                  >
                    −
                  </button>
                  <span className="w-8 text-center font-bold">{item.quantity}</span>
                  <button
                    className="btn-secondary h-8 w-8 p-0"
                    disabled={busyId === item.id}
                    onClick={() => patch(item.id, { quantity: item.quantity + 1 })}
                  >
                    +
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="text-[11px] text-slate-400 underline hover:text-slate-600"
                    disabled={busyId === item.id}
                    onClick={() => patch(item.id, { repriceProduct: true })}
                  >
                    {busyId === item.id ? "…" : "Check price"}
                  </button>
                  <button
                    className="text-[11px] text-red-500 underline hover:text-red-700"
                    disabled={busyId === item.id}
                    onClick={() => remove(item.id, item.product?.name ?? "this")}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="m-0 text-[11px] leading-snug text-slate-400">
        Sealed product is kept apart from your cards on purpose: it never appears in decks, in
        set completion, or in your card total. Values come from current sealed listings and are
        a guide, not an appraisal.
      </p>
    </div>
  );
}
