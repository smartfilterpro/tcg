"use client";

import { useEffect, useRef, useState } from "react";
import type { CardSummary } from "@/lib/types";

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
        <div className="mb-3 flex items-center gap-2">
          <input
            autoFocus
            className="input"
            placeholder='Search by name or number — e.g. "Charizard", "101/190", "#25"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {headerExtra}
          <button className="btn-secondary" onClick={onClose}>
            {toast !== undefined ? "Done" : "Close"}
          </button>
        </div>
        {toast && (
          <div className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            {toast}
          </div>
        )}
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
      </div>
    </div>
  );
}
