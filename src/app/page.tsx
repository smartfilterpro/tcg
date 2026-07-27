"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CardPickerModal from "@/components/CardPickerModal";
import { uploadCardPhoto } from "@/lib/photos";
import { matchesSearch } from "@/lib/text";
import { AI_NAME } from "@/lib/branding";

/** How much Trainer AI the user has left this month — a meter, not a bill. */
function AiMeter() {
  const [data, setData] = useState<{
    admin: boolean;
    percentUsed: number | null;
    calls: number;
    resetsOn: string;
    daily: number[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/usage/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setData(j))
      .catch(() => {});
  }, []);

  if (!data) return null;

  const pct = data.percentUsed;
  const barColor =
    pct == null ? "bg-poke-blue" : pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-yellow-500" : "bg-green-500";
  const resets = new Date(data.resetsOn).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div className="card-panel mb-4 p-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold">🤖 {AI_NAME} this month</span>
            <span className="text-slate-500">
              {data.admin || pct == null
                ? `${data.calls} call${data.calls === 1 ? "" : "s"} · unlimited`
                : pct >= 100
                  ? `All used — refills ${resets}`
                  : `${Math.round(100 - pct)}% left · refills ${resets}`}
            </span>
          </div>
          <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${pct == null ? (data.calls > 0 ? 6 : 0) : Math.max(pct, 2)}%` }}
            />
          </div>
        </div>
        {/* Last 14 days of activity, tallest bar = busiest day */}
        <div className="flex h-8 shrink-0 items-end gap-0.5" title="Your last 14 days of AI activity">
          {data.daily.map((v, i) => (
            <div
              key={i}
              className="w-1 rounded-t bg-poke-blue/50"
              style={{ height: `${Math.max(v * 100, 6)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
import {
  availableVariants,
  defaultVariantFor,
  itemPrice,
  variantLabel,
  STAMP_VARIANTS,
  type CardSummary,
  type CollectionItem,
} from "@/lib/types";

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
  const [showAdd, setShowAdd] = useState(false);
  const [changingCard, setChangingCard] = useState(false);
  const [addVariant, setAddVariant] = useState("auto");
  const [variantFilter, setVariantFilter] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [valueDraft, setValueDraft] = useState("");
  const [valueSaved, setValueSaved] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cards whose image URL failed to load (broken fallback-database links) —
  // treated exactly like having no image, so the photo button appears.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const detailPhotoRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [findBusy, setFindBusy] = useState(false);

  function markBroken(cardId: string) {
    setBrokenImages((prev) => new Set(prev).add(cardId));
  }

  function hasImage(item: CollectionItem) {
    return !!item.card.image_small && !brokenImages.has(item.card.id);
  }

  function applyCardImage(cardId: string, url: string) {
    const patchCard = (i: CollectionItem) =>
      i.card_id === cardId
        ? { ...i, card: { ...i.card, image_small: url, image_large: url } }
        : i;
    setItems((prev) => prev?.map(patchCard) ?? null);
    setSelected((s) => (s && s.card_id === cardId ? patchCard(s) : s));
    setBrokenImages((prev) => {
      const next = new Set(prev);
      next.delete(cardId);
      return next;
    });
  }

  async function setCardPhoto(item: CollectionItem, file: File) {
    setPhotoBusy(true);
    try {
      const url = await uploadCardPhoto(file);
      if (!url) {
        alert("Photo upload failed — has the card-photos storage migration (005) been run?");
        return;
      }
      const res = await fetch(`/api/cards/${encodeURIComponent(item.card_id)}/image`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        alert(json.error ?? "Couldn't save the photo");
        return;
      }
      applyCardImage(item.card_id, url);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function findImageOnline(item: CollectionItem) {
    setFindBusy(true);
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(item.card_id)}/find-image`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.error ?? "Couldn't find an image online — try your own photo.");
        return;
      }
      applyCardImage(item.card_id, json.imageUrl as string);
    } finally {
      setFindBusy(false);
    }
  }

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
    // Keyed by set NAME, not id: the same set can exist under two ids when
    // cards came from different databases (pokemontcg.io vs TCGdex), which
    // showed as duplicate entries in the dropdown.
    const sets = new Set<string>();
    const types = new Set<string>();
    const rarities = new Set<string>();
    const supertypes = new Set<string>();
    const variants = new Set<string>();
    for (const item of items ?? []) {
      const c = item.card;
      if (!c) continue;
      if (c.set_name) sets.add(c.set_name);
      for (const t of c.types ?? []) types.add(t);
      if (c.rarity) rarities.add(c.rarity);
      if (c.supertype) supertypes.add(c.supertype);
      variants.add(item.variant ?? "normal");
    }
    return {
      sets: [...sets].sort((a, b) => a.localeCompare(b)),
      types: [...types].sort(),
      rarities: [...rarities].sort(),
      supertypes: [...supertypes].sort(),
      variants: [...variants].sort(),
    };
  }, [items]);

  const filtered = useMemo(() => {
    let list = (items ?? []).filter((i) => i.card);
    // Punctuation/accent/space-blind matching — OCR'd or imported names can
    // carry odd characters that a strict substring match misses.
    const q = search.trim();
    if (q) {
      list = list.filter((i) =>
        matchesSearch(q, i.card.name, i.card.set_name, i.card.number)
      );
    }
    if (typeFilter) list = list.filter((i) => (i.card.types ?? []).includes(typeFilter));
    if (setFilter) list = list.filter((i) => i.card.set_name === setFilter);
    if (rarityFilter) list = list.filter((i) => i.card.rarity === rarityFilter);
    if (supertypeFilter) list = list.filter((i) => i.card.supertype === supertypeFilter);
    if (variantFilter) list = list.filter((i) => (i.variant ?? "normal") === variantFilter);
    switch (sort) {
      case "name":
        list = [...list].sort((a, b) => a.card.name.localeCompare(b.card.name));
        break;
      case "price":
        list = [...list].sort((a, b) => (itemPrice(b) ?? 0) - (itemPrice(a) ?? 0));
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
  }, [items, search, typeFilter, setFilter, rarityFilter, supertypeFilter, variantFilter, sort]);

  const totals = useMemo(() => {
    const all = (items ?? []).filter((i) => i.card);
    return {
      cards: all.reduce((s, i) => s + i.quantity, 0),
      unique: all.length,
      value: all.reduce((s, i) => s + (itemPrice(i) ?? 0) * i.quantity, 0),
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

  async function changeCard(item: CollectionItem, card: CardSummary) {
    setError(null);
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Couldn't change the card");
      setChangingCard(false);
      return;
    }
    setChangingCard(false);
    setSelected(null);
    await load(); // re-fetch so the row shows the new card's data
  }

  async function addCard(card: CardSummary) {
    const variant = addVariant === "auto" ? defaultVariantFor(card) : addVariant;
    const res = await fetch("/api/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ card, quantity: 1, variant }] }),
    });
    if (res.ok) {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(`Added ${card.name} (${variantLabel(variant)}) ×1 — click again for another copy`);
      toastTimer.current = setTimeout(() => setToast(null), 2500);
    } else {
      const json = await res.json().catch(() => ({}));
      setToast(`Couldn't add: ${json.error ?? "unknown error"}`);
    }
  }

  async function changeVariant(item: CollectionItem, variant: string) {
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(json.error ?? "Couldn't change finish");
      return;
    }
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, variant } : i)) ?? null);
    setSelected((s) => (s?.id === item.id ? { ...s, variant } : s));
  }

  async function saveNotes(item: CollectionItem) {
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notesDraft }),
    });
    if (res.ok) {
      setItems(
        (prev) =>
          prev?.map((i) => (i.id === item.id ? { ...i, notes: notesDraft || null } : i)) ?? null
      );
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    }
  }

  function openDetail(item: CollectionItem) {
    setSelected(item);
    setNotesDraft(item.notes ?? "");
    setNotesSaved(false);
    setValueDraft(item.price_override != null ? String(item.price_override) : "");
    setValueSaved(false);
  }

  async function saveValue(item: CollectionItem) {
    const trimmed = valueDraft.trim();
    const parsed = trimmed === "" ? null : parseFloat(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceOverride: parsed }),
    });
    if (res.ok) {
      setItems(
        (prev) =>
          prev?.map((i) => (i.id === item.id ? { ...i, price_override: parsed } : i)) ?? null
      );
      setSelected((s) => (s?.id === item.id ? { ...s, price_override: parsed } : s));
      setValueSaved(true);
      setTimeout(() => setValueSaved(false), 2000);
    }
  }

  function closeAdd() {
    setShowAdd(false);
    setToast(null);
    load(); // pull in whatever was added
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
          Scan your first cards, or add them by searching the card database.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link href="/scan" className="btn-primary">
            Scan cards
          </Link>
          <button className="btn-secondary" onClick={() => setShowAdd(true)}>
            + Add by search
          </button>
        </div>
        {showAdd && (
          <CardPickerModal
            initialQuery=""
            candidates={[]}
            onClose={closeAdd}
            onPick={addCard}
            toast={toast}
            headerExtra={
              <select
                className="input w-auto shrink-0"
                value={addVariant}
                onChange={(e) => setAddVariant(e.target.value)}
                title="Finish to add cards as"
              >
                <option value="auto">Finish: Auto</option>
                <option value="normal">Normal</option>
                <option value="holofoil">Holo</option>
                <option value="reverseHolofoil">Reverse Holo</option>
                <optgroup label="Stamped versions">
                  <option value="pcStamp">Pokémon Center Stamp</option>
                  <option value="prereleaseStamp">Prerelease Stamp</option>
                  <option value="staffStamp">Staff Stamp</option>
                </optgroup>
              </select>
            }
          />
        )}
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
          <button className="btn-secondary" onClick={() => setShowAdd(true)}>
            + Add by search
          </button>
          <Link href="/scan" className="btn-primary">
            + Scan cards
          </Link>
        </div>
      </div>

      <AiMeter />

      <div className="card-panel mb-4 space-y-2 p-3">
        {/* Full-width search on its own row; filters in a tidy grid below */}
        <input
          className="input w-full"
          type="search"
          placeholder="🔍 Search your cards by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <select className="input w-full min-w-0" value={supertypeFilter} onChange={(e) => setSupertypeFilter(e.target.value)}>
            <option value="">All card types</option>
            {facets.supertypes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select className="input w-full min-w-0" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All energy types</option>
            {facets.types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select className="input w-full min-w-0" value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
            <option value="">All sets</option>
            {facets.sets.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select className="input w-full min-w-0" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
            <option value="">All rarities</option>
            {facets.rarities.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select className="input w-full min-w-0" value={variantFilter} onChange={(e) => setVariantFilter(e.target.value)}>
            <option value="">All finishes</option>
            {facets.variants.map((v) => (
              <option key={v} value={v}>{variantLabel(v)}</option>
            ))}
          </select>
          <select className="input w-full min-w-0" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="newest">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="price">Highest value</option>
            <option value="set">By set</option>
          </select>
        </div>
      </div>

      <p className="mb-2 text-xs text-slate-400">{filtered.length} shown</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {filtered.map((item) => (
          <button
            key={item.id}
            className="card-panel group relative overflow-hidden p-2 text-left transition-transform hover:-translate-y-0.5 hover:shadow-md"
            onClick={() => openDetail(item)}
          >
            {item.quantity > 1 && (
              <span className="absolute right-2 top-2 z-10 rounded-full bg-poke-dark px-2 py-0.5 text-xs font-bold text-white">
                ×{item.quantity}
              </span>
            )}
            {(item.variant ?? "normal") !== "normal" && (
              <span className="absolute left-2 top-2 z-10 rounded-full bg-poke-gold px-2 py-0.5 text-[10px] font-bold text-poke-dark shadow">
                {variantLabel(item.variant)}
              </span>
            )}
            {hasImage(item) ? (
              // Fixed card aspect ratio — user-taken photos (arbitrary shapes)
              // otherwise distort the grid
              <div className="aspect-[63/88] w-full overflow-hidden rounded">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.card.image_small!}
                  alt={item.card.name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  onError={() => markBroken(item.card.id)}
                />
              </div>
            ) : (
              <div className="flex aspect-[63/88] flex-col items-center justify-center gap-1 rounded bg-slate-100 text-center text-xs text-slate-400">
                <span className="text-xl">📷</span>
                No image — tap to add a photo
              </div>
            )}
            <div className="mt-2 truncate text-sm font-semibold">{item.card.name}</div>
            <div className="truncate text-xs text-slate-500">
              {item.card.set_name} · #{item.card.number}
            </div>
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="truncate text-slate-400">{item.card.rarity ?? ""}</span>
              {itemPrice(item) != null && (
                <span className="font-semibold text-green-700">
                  ${itemPrice(item)!.toFixed(2)}
                  {item.price_override != null ? "*" : ""}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Detail-modal photo capture for cards without art */}
      <input
        ref={detailPhotoRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && selected) setCardPhoto(selected, f);
        }}
      />

      {showAdd && (
        <CardPickerModal
          initialQuery=""
          candidates={[]}
          onClose={closeAdd}
          onPick={addCard}
          toast={toast}
        />
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="card-panel relative mx-auto my-6 w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
            <div className="flex gap-4 pr-6">
              {hasImage(selected) ? (
                <div className="flex aspect-[63/88] w-40 shrink-0 items-center justify-center self-start overflow-hidden rounded-lg bg-slate-100 shadow">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selected.card.image_large ?? selected.card.image_small!}
                    alt={selected.card.name}
                    className="h-full w-full object-contain"
                    onError={() => markBroken(selected.card.id)}
                  />
                </div>
              ) : (
                <div className="flex aspect-[63/88] w-40 flex-col items-center justify-center gap-2 self-start rounded-lg bg-slate-100 p-3 text-center text-xs text-slate-400">
                  <span className="text-2xl">📷</span>
                  No card art available
                  <button
                    className="btn-primary px-3 py-1.5 text-xs"
                    disabled={photoBusy || findBusy}
                    onClick={() => findImageOnline(selected)}
                  >
                    {findBusy ? "Searching…" : "🔍 Find image online"}
                  </button>
                  <button
                    className="btn-secondary px-3 py-1.5 text-xs"
                    disabled={photoBusy || findBusy}
                    onClick={() => detailPhotoRef.current?.click()}
                  >
                    {photoBusy ? "Uploading…" : "📷 Use your photo"}
                  </button>
                </div>
              )}
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
                  <div className="flex items-center gap-2">
                    Finish:
                    <select
                      className="input w-auto py-1 text-xs"
                      value={selected.variant ?? "normal"}
                      onChange={(e) => changeVariant(selected, e.target.value)}
                    >
                      {[
                        ...new Set([
                          ...availableVariants(selected.card),
                          ...STAMP_VARIANTS,
                          selected.variant ?? "normal",
                        ]),
                      ].map((v) => (
                        <option key={v} value={v}>
                          {variantLabel(v)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {itemPrice(selected) != null && (
                    <div className="font-semibold text-green-700">
                      {selected.price_override != null ? "Your value" : "Market"} (
                      {variantLabel(selected.variant ?? "normal")}): $
                      {itemPrice(selected)!.toFixed(2)} each
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs text-slate-500">Your value $</span>
                    <input
                      className="input w-24 py-1 text-xs"
                      inputMode="decimal"
                      placeholder="auto"
                      value={valueDraft}
                      onChange={(e) => setValueDraft(e.target.value)}
                    />
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => saveValue(selected)}>
                      Set
                    </button>
                    {valueSaved && <span className="text-xs text-green-600">✓</span>}
                  </div>
                  <p className="text-[11px] leading-snug text-slate-400">
                    Overrides the market price — use for Pokémon Center stamps, graded cards,
                    etc. Clear the box and Set to go back to market pricing.
                  </p>
                </dl>
              </div>
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3">
              <label className="text-xs font-semibold text-slate-500">
                Notes (e.g. “Pokémon Center stamp”, “graded PSA 9”)
              </label>
              <textarea
                className="input mt-1 min-h-16 text-sm"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="Anything special about your copy…"
              />
              <div className="mt-1 flex items-center gap-2">
                <button className="btn-secondary text-xs" onClick={() => saveNotes(selected)}>
                  Save notes
                </button>
                {notesSaved && <span className="text-xs text-green-600">Saved ✓</span>}
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
              <div className="flex items-center gap-1">
                <button
                  className="btn text-sm text-slate-600 hover:bg-slate-100"
                  title="Matched to the wrong card? Search and swap the identification — quantity and notes are kept."
                  onClick={() => setChangingCard(true)}
                >
                  🔁 Change card
                </button>
                <button
                  className="btn text-sm text-red-600 hover:bg-red-50"
                  onClick={() => updateQuantity(selected, 0)}
                >
                  Remove all
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selected && changingCard && (
        <CardPickerModal
          initialQuery={`${selected.card.name} ${selected.card.number}`}
          candidates={[]}
          onClose={() => setChangingCard(false)}
          onPick={(card) => changeCard(selected, card)}
        />
      )}
    </div>
  );
}
