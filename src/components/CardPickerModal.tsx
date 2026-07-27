"use client";

import { useEffect, useRef, useState } from "react";
import { uploadCardPhoto } from "@/lib/photos";
import type { CardSummary } from "@/lib/types";

const ENERGY_TYPES = [
  "Grass", "Fire", "Water", "Lightning", "Psychic",
  "Fighting", "Darkness", "Metal", "Dragon", "Colorless",
];

/** Form for cards the reference database doesn't have yet (brand-new sets,
 *  promos, etc. — the database lags months behind new releases). */
function ManualCardForm({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  onSubmit: (card: CardSummary) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [setLabel, setSetLabel] = useState("");
  const [number, setNumber] = useState("");
  const [supertype, setSupertype] = useState("Pokémon");
  const [energyType, setEnergyType] = useState("");
  const [rarity, setRarity] = useState("");
  const [price, setPrice] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    let photoUrl: string | null = null;
    if (photo) photoUrl = await uploadCardPhoto(photo);
    const parsedPrice = parseFloat(price);
    setSaving(false);
    onSubmit({
      id: `custom-${crypto.randomUUID()}`,
      name: name.trim(),
      supertype,
      subtypes: [],
      types: energyType ? [energyType] : [],
      hp: null,
      number: number.trim() || "—",
      rarity: rarity.trim() || "Promo",
      setId: "custom",
      setName: setLabel.trim() || "Custom / Promo",
      setSeries: null,
      setPrintedTotal: null,
      releaseDate: null,
      imageSmall: photoUrl,
      imageLarge: photoUrl,
      marketPrice: Number.isFinite(parsedPrice) ? parsedPrice : null,
      prices: null,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs text-slate-500">
        For cards the database doesn&apos;t have yet (new sets and promos lag by months).
        It&apos;ll show without card art until the database catches up.
      </p>
      <input
        className="input"
        placeholder="Card name * — e.g. Mega Gengar ex"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Set / promo series — e.g. ME Black Star Promos"
          value={setLabel}
          onChange={(e) => setSetLabel(e.target.value)}
        />
        <input
          className="input w-28 shrink-0"
          placeholder="No. — 073"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <select className="input" value={supertype} onChange={(e) => setSupertype(e.target.value)}>
          <option>Pokémon</option>
          <option>Trainer</option>
          <option>Energy</option>
        </select>
        <select className="input" value={energyType} onChange={(e) => setEnergyType(e.target.value)}>
          <option value="">Energy type…</option>
          {ENERGY_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Rarity — e.g. Promo, SIR"
          value={rarity}
          onChange={(e) => setRarity(e.target.value)}
        />
        <input
          className="input w-32 shrink-0"
          placeholder="Value $ (opt.)"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="btn-secondary cursor-pointer text-sm">
          {photo ? "📷 Change photo" : "📷 Photo of your card (optional)"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setPhoto(f);
              setPhotoPreview(f ? URL.createObjectURL(f) : null);
              e.target.value = "";
            }}
          />
        </label>
        {photoPreview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoPreview} alt="card photo" className="h-14 rounded shadow-sm" />
        )}
      </div>
      <div className="flex gap-2">
        <button type="submit" className="btn-primary text-sm" disabled={saving}>
          {saving ? "Saving…" : "Add this card"}
        </button>
        <button type="button" className="btn-secondary text-sm" onClick={onCancel}>
          Back to search
        </button>
      </div>
    </form>
  );
}

/** Search-the-database picker — used to correct a misidentified scan and to
 *  add cards manually. When `toast` is provided, the modal stays open after a
 *  pick (multi-add mode) and shows the toast as feedback. */
export default function CardPickerModal({
  initialQuery,
  candidates,
  onPick,
  onClose,
  toast,
  headerExtra,
}: {
  initialQuery: string;
  candidates: CardSummary[];
  onPick: (card: CardSummary) => void;
  onClose: () => void;
  toast?: string | null;
  headerExtra?: React.ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<CardSummary[]>(candidates);
  const [loading, setLoading] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim() || query === initialQuery) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query.trim())}`);
        const json = await res.json();
        if (res.ok) setResults(json.cards);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, initialQuery]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="card-panel flex max-h-[85vh] w-full max-w-2xl flex-col p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search gets a full-width row on phones; controls wrap below it */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            autoFocus
            type="search"
            className="input w-full sm:w-auto sm:flex-1"
            placeholder='🔍 Search by name or number — e.g. "Charizard", "101/190"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto">
            {headerExtra ?? <span />}
            <button className="btn-secondary shrink-0" onClick={onClose}>
              {toast !== undefined ? "Done" : "Close"}
            </button>
          </div>
        </div>
        {toast && (
          <div className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            {toast}
          </div>
        )}
        {manualMode ? (
          <ManualCardForm
            initialName={query}
            onSubmit={(card) => {
              onPick(card);
              setManualMode(false);
            }}
            onCancel={() => setManualMode(false)}
          />
        ) : (
          <>
        {loading && <p className="py-2 text-sm text-slate-400">Searching…</p>}
        {!loading && results.length === 0 && !query.trim() && (
          <p className="py-6 text-center text-sm text-slate-400">
            Type a card name or number to search the full card database.
          </p>
        )}
        <div className="grid flex-1 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
          {results.map((card) => (
            <button
              key={card.id}
              className="rounded-lg border border-transparent p-1 text-left hover:border-poke-blue hover:bg-blue-50"
              onClick={() => onPick(card)}
            >
              {card.imageSmall ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={card.imageSmall} alt={card.name} className="w-full rounded" loading="lazy" />
              ) : (
                <div className="flex aspect-[63/88] items-center justify-center rounded bg-slate-100 text-xs text-slate-400">
                  No image
                </div>
              )}
              <div className="mt-1 truncate text-xs font-semibold">{card.name}</div>
              <div className="truncate text-[11px] text-slate-500">
                {card.setName} · #{card.number}
              </div>
            </button>
          ))}
          {!loading && results.length === 0 && !!query.trim() && (
            <p className="col-span-full py-6 text-center text-sm text-slate-400">
              No results — try a different name or number.
            </p>
          )}
        </div>
        <div className="mt-3 border-t border-slate-100 pt-2 text-center">
          <button
            className="text-xs text-poke-blue hover:underline"
            onClick={() => setManualMode(true)}
          >
            Card not in the database (new set / promo)? Add it manually →
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
