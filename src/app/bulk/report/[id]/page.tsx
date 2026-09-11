"use client";

// The customer's view of their scanned stack: every card that was added
// to their collection, the actual scan photo beside the catalogue card it
// was filed as. Opened from a tokenized link — no account needed. This is
// the confidence page: the person can check the work card by card.

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface ReportCard {
  seq: number;
  scan: string | null;
  flipped: boolean;
  name: string;
  number: string;
  set: string | null;
  image: string | null;
  finish: string;
  humanChecked: boolean;
}

const FINISH_LABELS: Record<string, string> = {
  normal: "Normal",
  holofoil: "Holo",
  reverseHolofoil: "Reverse Holo",
  foil: "Foil",
  pokeBall: "Poké Ball pattern",
  masterBall: "Master Ball pattern",
  friendBall: "Friend Ball pattern",
  loveBall: "Love Ball pattern",
  energySymbol: "Energy Symbol pattern",
};

export default function BulkReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const search = useSearchParams();
  const token = search.get("t") ?? "";
  const [data, setData] = useState<{
    label: string;
    uploadedAt: string | null;
    count: number;
    cards: ReportCard[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/bulk/report?job=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Couldn't load the report.");
        setData(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load the report.");
      }
    })();
  }, [id, token]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-6 text-center">
        <h1 className="text-xl font-bold">Scan report</h1>
        <p className="mt-4 text-sm text-red-600">{error}</p>
      </main>
    );
  }
  if (!data) {
    return <main className="mx-auto max-w-2xl p-6 text-center text-sm text-slate-500">Loading your report…</main>;
  }

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-2xl font-bold">Scan report — {data.label}</h1>
      <p className="mt-1 text-sm text-slate-600">
        {data.count} card{data.count === 1 ? "" : "s"} scanned and added
        {data.uploadedAt ? ` · ${new Date(data.uploadedAt).toLocaleString()}` : ""}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        Each row shows the photo of your actual card next to the catalogue card it was recorded
        as. Every card was identified by machine and double-checked; rows marked ✓ were also
        confirmed by a person. If anything looks wrong, reply to whoever sent you this link with
        the card number.
      </p>
      <ul className="mt-4 flex list-none flex-col gap-3 p-0">
        {data.cards.map((c) => (
          <li key={c.seq} className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
            {c.scan ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={c.scan}
                alt={`scan of ${c.name}`}
                className={`h-36 rounded-lg object-contain ${c.flipped ? "rotate-180" : ""}`}
              />
            ) : (
              <div className="flex aspect-[63/88] h-36 items-center justify-center rounded-lg bg-slate-100 text-[10px] text-slate-400">
                no photo
              </div>
            )}
            {c.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.image} alt={c.name} className="h-36 rounded-lg object-contain" />
            ) : null}
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold">
                #{c.seq} · {c.name}
              </div>
              <div className="text-slate-600">
                {c.set ?? "—"} · #{c.number}
              </div>
              <div className="text-slate-600">Finish: {FINISH_LABELS[c.finish] ?? c.finish}</div>
              {c.humanChecked && <div className="text-green-700">✓ human-checked</div>}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-center text-xs text-slate-400">Prepared with TrainerDeck.</p>
    </main>
  );
}
