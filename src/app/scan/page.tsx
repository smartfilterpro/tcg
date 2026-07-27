"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import CardPickerModal from "@/components/CardPickerModal";
import { AI_NAME } from "@/lib/branding";
import { uploadCardPhoto } from "@/lib/photos";
import {
  availableVariants,
  defaultVariantFor,
  variantLabel,
  STAMP_VARIANTS,
  type CardSummary,
  type ScanMatch,
} from "@/lib/types";

interface ReviewRow {
  key: number;
  detected: ScanMatch["detected"];
  card: CardSummary | null; // the (possibly corrected) identification
  candidates: CardSummary[];
  quantity: number;
  variant: string; // finish: normal | holofoil | reverseHolofoil | ...
  photoUrl: string | null; // user-taken photo, used when the DB has no image
  originalCardId: string | null; // the scan's auto-match, to measure accuracy
}

/** Downscale a photo client-side so uploads stay fast and under limits. */
async function fileToBase64(file: File, maxDim = 2048): Promise<{ data: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  return { data: dataUrl.split(",")[1], mediaType: "image/jpeg" };
}

const SCAN_STEPS = [
  `${AI_NAME} is reading the cards in your photo…`,
  "Finding names and collector numbers…",
  "Matching against the card database…",
  "Double-checking sets and rarities…",
  "Looking up market prices…",
  "Almost there — big scans take a little longer…",
];

export default function ScanPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [scanStep, setScanStep] = useState(0);
  const [phase, setPhase] = useState<"idle" | "scanning" | "review" | "saving" | "done">("idle");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pickerRow, setPickerRow] = useState<ReviewRow | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoRowKey, setPhotoRowKey] = useState<number | null>(null);
  const [photoUploading, setPhotoUploading] = useState<number | null>(null);
  const [scanSeconds, setScanSeconds] = useState<number | null>(null);

  // Rotate through status messages while a scan is running so the page
  // clearly isn't frozen (scans take 10-30s depending on card count).
  useEffect(() => {
    if (phase !== "scanning") return;
    setScanStep(0);
    const interval = setInterval(
      () => setScanStep((s) => Math.min(s + 1, SCAN_STEPS.length - 1)),
      3500
    );
    return () => clearInterval(interval);
  }, [phase]);

  async function handleFile(file: File) {
    setError(null);
    setPhase("scanning");
    setPreview(URL.createObjectURL(file));
    const startedAt = Date.now();
    try {
      const { data, mediaType } = await fileToBase64(file);
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: data, mediaType }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Scan failed");
      const results: ScanMatch[] = json.results;
      if (results.length === 0) {
        throw new Error("No cards were detected. Try better lighting and make sure the collector numbers are visible.");
      }
      setRows(
        results.map((r, i) => ({
          key: i,
          detected: r.detected,
          card: r.match,
          candidates: r.candidates,
          quantity: 1,
          variant: r.match ? defaultVariantFor(r.match, r.detected.rarityHint) : "normal",
          photoUrl: null,
          originalCardId: r.match?.id ?? null,
        }))
      );
      setScanSeconds(Math.round((Date.now() - startedAt) / 1000));
      setPhase("review");
      // Single-card scan with no database image (common for promos): use the
      // photo just taken as the card's image, automatically.
      if (results.length === 1 && results[0].match && !results[0].match.imageSmall) {
        uploadCardPhoto(file).then((url) => {
          if (url) {
            setRows((prev) => prev.map((r) => (r.key === 0 ? { ...r, photoUrl: url } : r)));
          }
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setPhase("idle");
    }
  }

  function updateRow(key: number, patch: Partial<ReviewRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: number) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  async function save() {
    const valid = rows.filter((r) => r.card && r.quantity > 0);
    if (valid.length === 0) return;
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch("/api/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: valid.map((r) => ({
            card:
              r.card && !r.card.imageSmall && r.photoUrl
                ? { ...r.card, imageSmall: r.photoUrl, imageLarge: r.photoUrl }
                : r.card,
            quantity: r.quantity,
            variant: r.variant,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setAddedCount(json.added);
      // Best-effort analytics: how long the scan took and how often the
      // auto-match was kept (admin dashboard fodder).
      fetch("/api/scan/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          durationMs: (scanSeconds ?? 0) * 1000,
          detected: rows.length,
          autoMatched: rows.filter((r) => r.originalCardId).length,
          saved: valid.length,
          keptMatch: valid.filter((r) => r.originalCardId && r.card?.id === r.originalCardId)
            .length,
        }),
      }).catch(() => {});
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setPhase("review");
    }
  }

  function reset() {
    setRows([]);
    setPreview(null);
    setError(null);
    setPhase("idle");
  }

  const confidenceChip = {
    high: "bg-green-100 text-green-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-red-100 text-red-800",
  } as const;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Scan cards</h1>
      <p className="mb-4 text-sm text-slate-500">
        Snap one card or a whole spread — lay cards flat, avoid glare, and keep the
        little number at the bottom (e.g. 042/191) readable.
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Per-row card photo capture (used when the database has no card art) */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f || photoRowKey === null) return;
          const key = photoRowKey;
          setPhotoUploading(key);
          const url = await uploadCardPhoto(f);
          setPhotoUploading(null);
          if (url) updateRow(key, { photoUrl: url });
          else setError("Photo upload failed — has the card-photos storage migration been run?");
        }}
      />

      {phase === "idle" && (
        <div className="card-panel p-8 text-center">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <div className="text-5xl">📷</div>
          <p className="mt-3 text-slate-600">Take a photo or choose one from your library.</p>
          <button className="btn-primary mt-4" onClick={() => fileRef.current?.click()}>
            Take / choose photo
          </button>
        </div>
      )}

      {phase === "scanning" && (
        <div className="card-panel p-8 text-center">
          {preview && (
            <div className="relative mx-auto mb-5 inline-block overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="scan preview" className="max-h-64 rounded-lg" />
              <div className="absolute inset-0 bg-poke-dark/20" />
              <div className="scan-beam" />
            </div>
          )}
          <div className="flex items-center justify-center gap-3">
            <span className="animate-spin-slow inline-block h-6 w-6 shrink-0 rounded-full border-2 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
            <span className="text-lg font-semibold">Identifying cards…</span>
          </div>
          <p className="mt-2 min-h-5 text-sm text-slate-500 transition-opacity" key={scanStep}>
            {SCAN_STEPS[scanStep]}
          </p>
          <div className="mx-auto mt-4 flex max-w-48 gap-1">
            {SCAN_STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors duration-500 ${
                  i <= scanStep ? "bg-poke-red" : "bg-slate-200"
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {(phase === "review" || phase === "saving") && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">
              {rows.length} card{rows.length === 1 ? "" : "s"} detected
              {scanSeconds != null && (
                <span className="font-normal text-slate-400"> in {scanSeconds}s</span>
              )}{" "}
              — review before saving
            </p>
            <button className="btn-secondary text-xs" onClick={reset}>
              Start over
            </button>
          </div>
          <p className="mb-3 -mt-1 text-[11px] text-slate-400">
            💡 Double-check the finish: <b>Holo</b> = only the artwork shines ·{" "}
            <b>Reverse Holo</b> = everything <i>but</i> the artwork shines ·{" "}
            gold logo stamped on the art = stamped promo.
          </p>

          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.key} className="card-panel flex gap-3 p-3">
                {row.card?.imageSmall || row.photoUrl ? (
                  <div className="aspect-[63/88] w-20 shrink-0 self-start overflow-hidden rounded">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={row.card?.imageSmall ?? row.photoUrl!}
                      alt={row.card?.name ?? "your photo"}
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="flex aspect-[63/88] w-20 items-center justify-center self-start rounded bg-slate-100 text-center text-[10px] text-slate-400">
                    {row.card ? "No image in database" : "No match"}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {row.card ? row.card.name : `“${row.detected.name}” — not found`}
                    </span>
                    <span className={`chip ${confidenceChip[row.detected.confidence]}`}>
                      {row.detected.confidence === "high" ? "✓ confident" : `⚠ ${row.detected.confidence} confidence`}
                    </span>
                  </div>
                  {row.card ? (
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.card.setName} · #{row.card.number}
                      {row.card.setPrintedTotal ? `/${row.card.setPrintedTotal}` : ""}
                      {row.card.rarity ? ` · ${row.card.rarity}` : ""}
                      {row.card.marketPrice != null ? ` · $${row.card.marketPrice.toFixed(2)}` : ""}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Saw: {row.detected.name}
                      {row.detected.collectorNumber ? ` #${row.detected.collectorNumber}` : ""}
                      {row.detected.setTotal ? `/${row.detected.setTotal}` : ""}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1">
                      <button
                        className="btn-secondary h-8 w-8 p-0 text-base"
                        onClick={() => updateRow(row.key, { quantity: Math.max(1, row.quantity - 1) })}
                      >
                        −
                      </button>
                      <span className="w-8 text-center text-sm font-bold">{row.quantity}</span>
                      <button
                        className="btn-secondary h-8 w-8 p-0 text-base"
                        onClick={() => updateRow(row.key, { quantity: row.quantity + 1 })}
                      >
                        +
                      </button>
                    </div>
                    {row.card && (
                      <select
                        className="input w-auto py-1.5 text-xs"
                        value={row.variant}
                        onChange={(e) => updateRow(row.key, { variant: e.target.value })}
                        title="Finish — the scanner can't always tell holo from reverse holo or spot stamps; correct it here"
                      >
                        {availableVariants(row.card).map((v) => (
                          <option key={v} value={v}>
                            {variantLabel(v)}
                            {row.card!.prices?.[v] != null
                              ? ` · $${row.card!.prices![v]!.toFixed(2)}`
                              : ""}
                          </option>
                        ))}
                        <optgroup label="Stamped versions">
                          {STAMP_VARIANTS.map((v) => (
                            <option key={v} value={v}>
                              {variantLabel(v)}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    )}
                    {row.card && !row.card.imageSmall && (
                      <button
                        className="btn-secondary text-xs"
                        disabled={photoUploading === row.key}
                        onClick={() => {
                          setPhotoRowKey(row.key);
                          photoInputRef.current?.click();
                        }}
                        title="No card art in the database — use your own photo instead"
                      >
                        {photoUploading === row.key
                          ? "Uploading…"
                          : row.photoUrl
                            ? "📷 Retake photo"
                            : "📷 Add photo"}
                      </button>
                    )}
                    <button className="btn-secondary text-xs" onClick={() => setPickerRow(row)}>
                      {row.card ? "Change card" : "Find card"}
                    </button>
                    <button
                      className="btn text-xs text-red-600 hover:bg-red-50"
                      onClick={() => removeRow(row.key)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="sticky bottom-4 mt-4">
            <button
              className="btn-primary w-full py-3 text-base shadow-lg"
              disabled={phase === "saving" || rows.every((r) => !r.card)}
              onClick={save}
            >
              {phase === "saving"
                ? "Saving…"
                : `Add ${rows.filter((r) => r.card).reduce((s, r) => s + r.quantity, 0)} card(s) to collection`}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="card-panel p-8 text-center">
          <div className="text-5xl">🎉</div>
          <h2 className="mt-2 text-xl font-bold">{addedCount} card(s) added!</h2>
          <div className="mt-4 flex justify-center gap-3">
            <button className="btn-primary" onClick={reset}>
              Scan more
            </button>
            <button className="btn-secondary" onClick={() => router.push("/")}>
              View collection
            </button>
          </div>
        </div>
      )}

      {pickerRow && (
        <CardPickerModal
          initialQuery={pickerRow.detected.name}
          candidates={pickerRow.candidates}
          onClose={() => setPickerRow(null)}
          onPick={(card) => {
            updateRow(pickerRow.key, {
              card,
              variant: defaultVariantFor(card, pickerRow.detected.rarityHint),
            });
            setPickerRow(null);
          }}
        />
      )}
    </div>
  );
}
