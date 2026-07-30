"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import CardPickerModal from "@/components/CardPickerModal";
import { CreditLock } from "@/components/CreditLock";
import { useCredits } from "@/components/useCredits";
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
import { FanMark } from "@/components/Logo";
import { detectCards, type CardBox } from "@/lib/multiCardDetect";

interface ReviewRow {
  key: number;
  detected: ScanMatch["detected"];
  card: CardSummary | null; // the (possibly corrected) identification
  candidates: CardSummary[];
  quantity: number;
  variant: string; // finish: normal | holofoil | reverseHolofoil | ...
  photoUrl: string | null; // user-taken photo, used when the DB has no image
  originalCardId: string | null; // the scan's auto-match, to measure accuracy
  predictedVariant: string | null; // the finish the scanner suggested, to learn from edits
}

/** Downscale a photo client-side so uploads stay fast and under limits.
 *
 *  1568 rather than 2048 because that is the API's own ceiling: anything
 *  longer on either edge is resized down to fit before it is billed, so the
 *  extra pixels were never read and never charged for — they were just a
 *  bigger upload, which on a phone on mobile data is the part the user feels.
 *  Sending exactly what the model will see costs the same tokens and about
 *  40% fewer bytes. Do not raise this expecting better recognition; the
 *  server-side resize would undo it. */
async function fileToBase64(
  file: File,
  maxDim = 1568
): Promise<{ data: string; mediaType: string; boxes: CardBox[] }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);

  // Find the cards while we have the pixels in hand — the same canvas is
  // already here for the resize, so this costs one getImageData and about
  // 40ms rather than a second decode.
  let boxes: CardBox[] = [];
  try {
    const pixels = ctx.getImageData(0, 0, w, h);
    boxes = detectCards({ data: pixels.data, width: w, height: h });
  } catch {
    // Detection is decoration. A failure here must never stop a scan.
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  return { data: dataUrl.split(",")[1], mediaType: "image/jpeg", boxes };
}


export default function ScanPage() {
  const router = useRouter();
  const creditState = useCredits();
  const fileRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  /** Real progress: how many cards the model has finished reading, and how
   *  many it said were in the photo. */
  const [progress, setProgress] = useState<{ read: number; expected: number | null }>({
    read: 0,
    expected: null,
  });
  const [partial, setPartial] = useState<Array<{ name: string; num: string | null }>>([]);
  /** Card outlines found in the photo before it was even sent. Cosmetic: a
   *  card the detector misses is still read by the model. */
  const [boxes, setBoxes] = useState<CardBox[]>([]);
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

  // Pick up a scan that was already running.
  //
  // The case this exists for: the photo goes in, the phone locks, and the
  // person comes back two minutes later to a fresh scan page. The cards are
  // sitting on the server, already paid for. Without this they'd be invisible
  // and the obvious move would be to scan again — paying twice for one photo.
  useEffect(() => {
    if (phase !== "idle") return;
    let live = true;
    fetch("/api/scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const job = j?.job as { id: string; status: string } | null | undefined;
        if (!live || !job || job.status !== "running") return;
        setPhase("scanning");
        setJobId(job.id);
        watchJob(job.id, Date.now())
          .then((results) => results && applyResults(results, Date.now()))
          .catch((e) => {
            setError(e instanceof Error ? e.message : "Scan failed");
            setPhase("idle");
          });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the screen awake while a scan runs, where the browser allows it.
  // Doesn't replace the job — the job is what makes sleeping survivable —
  // but it stops the common case from happening at all.
  useEffect(() => {
    if (phase !== "scanning") return;
    let sentinel: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((s) => {
        sentinel = s;
      })
      .catch(() => {
        // Denied, unsupported, or the tab isn't visible. Not worth a word to
        // the user — the scan survives sleeping either way.
      });
    return () => {
      void sentinel?.release().catch(() => {});
    };
  }, [phase]);

  /** Watch a scan job until it finishes.
   *
   *  Polling, not a stream, and that is the point: a stream dies when the
   *  phone sleeps or the tab goes to the background, whereas a poll simply
   *  resumes on the next tick. The scan itself runs server-side regardless,
   *  so falling asleep mid-scan now costs nothing — the cards are waiting.
   */
  async function watchJob(jobId: string, startedAt: number) {
    for (;;) {
      const res = await fetch(`/api/scan?job=${encodeURIComponent(jobId)}`);
      const json = await res.json();
      const job = json.job as {
        status: string;
        expected: number | null;
        cards: unknown[];
        error: string | null;
      } | null;

      if (!job) throw new Error("That scan couldn't be found.");
      if (job.status === "error") throw new Error(job.error || "Scan failed");
      if (job.status === "cancelled") return null;

      // Cards read so far — the real numerator behind "4 of 6".
      setProgress((prev) => ({
        read: job.cards?.length ?? 0,
        // The model's count wins once it exists; until then keep whatever
        // the detector found rather than dropping back to "unknown".
        expected: job.expected ?? prev.expected,
      }));
      setPartial(
        (job.cards ?? []).map((c) => {
          const o = c as { name?: string; num?: string | null; detected?: { name?: string } };
          return { name: o.detected?.name ?? o.name ?? "Reading…", num: o.num ?? null };
        })
      );

      if (job.status === "done") return job.cards as ScanMatch[];
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setPhase("scanning");
    setProgress({ read: 0, expected: null });
    setPartial([]);
    setBoxes([]);
    setPreview(URL.createObjectURL(file));
    const startedAt = Date.now();
    try {
      const { data, mediaType, boxes: found } = await fileToBase64(file);
      setBoxes(found);
      // A denominator before the model has said anything. Replaced by its
      // own count the moment that arrives — the model is the authority on
      // how many cards there are, this is just a head start.
      if (found.length > 0) setProgress({ read: 0, expected: found.length });
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: data, mediaType }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Scan failed");
      setJobId(json.jobId);
      const watched = await watchJob(json.jobId, startedAt);
      if (!watched) {
        reset();
        return;
      }
      applyResults(watched, startedAt, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
      setPhase("idle");
    }
  }

  /** Turn a finished job's cards into review rows. Shared by a scan that ran
   *  to completion in front of you and one recovered after a sleep. */
  function applyResults(results: ScanMatch[], startedAt: number, file?: File) {
    if (results.length === 0) {
      setError(
        "No cards were detected. Try better lighting and make sure the collector numbers are visible."
      );
      setPhase("idle");
      return;
    }
    setRows(
        results.map((r, i) => {
          // Learned memory (past member corrections) beats the fresh guess.
          const variant =
            r.suggestedVariant ??
            (r.match ? defaultVariantFor(r.match, r.detected.rarityHint) : "normal");
          return {
            key: i,
            detected: r.detected,
            card: r.match,
            candidates: r.candidates,
            quantity: 1,
            variant,
            photoUrl: null,
            originalCardId: r.match?.id ?? null,
            predictedVariant: r.match ? variant : null,
          };
        })
      );
    setScanSeconds(Math.round((Date.now() - startedAt) / 1000));
    setPhase("review");
    // Single-card scan with no database image (common for promos): use the
    // photo just taken as the card's image, automatically. Only available on
    // the live path — a scan recovered after a sleep no longer has the file.
    if (file && results.length === 1 && results[0].match && !results[0].match.imageSmall) {
      uploadCardPhoto(file).then((url) => {
        if (url) {
          setRows((prev) => prev.map((r) => (r.key === 0 ? { ...r, photoUrl: url } : r)));
        }
      });
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
      // Best-effort learning: tell the scanner which finish guesses were kept
      // and which were corrected, so repeat scans of the same card improve.
      const feedback = valid
        .filter((r) => r.card && r.predictedVariant)
        .map((r) => ({
          cardId: r.card!.id,
          predicted: r.predictedVariant!,
          corrected: r.variant,
        }));
      if (feedback.length > 0) {
        fetch("/api/scan/finish-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: feedback }),
        }).catch(() => {});
      }
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
          {/* Identifying a card is a model call, so it's the credit balance
              that decides — not the plan. Free users scan until they run
              out; so do paid ones. */}
          {creditState.empty ? (
            <div className="mt-4 flex items-center justify-center">
              <CreditLock plan={creditState.credits?.plan} label="Out of credits to scan" />
            </div>
          ) : (
            <button className="btn-primary mt-4" onClick={() => fileRef.current?.click()}>
              Take / choose photo
            </button>
          )}
        </div>
      )}

      {phase === "scanning" && (
        <div className="card-panel p-6 text-center">
          {preview && (
            <div className="relative mx-auto mb-5 inline-block overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="scan preview" className="max-h-56 rounded-lg" />
              <div className="absolute inset-0 bg-poke-dark/20" />
              <div className="scan-beam" />
              {/* Outlines found locally, before the photo was sent. They fill
                  in as the model names each card — box i belongs to card i,
                  since both run in reading order. Percentages, so they track
                  the image at whatever size it rendered. */}
              {boxes.map((b, i) => (
                <div
                  key={i}
                  className={`absolute rounded-[3px] border-2 transition-colors duration-300 ${
                    i < progress.read
                      ? "border-poke-red bg-poke-red/10"
                      : "border-white/70"
                  }`}
                  style={{
                    left: `${b.x * 100}%`,
                    top: `${b.y * 100}%`,
                    width: `${b.w * 100}%`,
                    height: `${b.h * 100}%`,
                  }}
                >
                  {partial[i] && (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-poke-red px-1 py-px text-[8px] font-medium leading-tight text-white">
                      {partial[i].name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {boxes.length > 0 && progress.read === 0 && (
            <p className="mb-2 -mt-3 font-mono text-[11px] uppercase tracking-wide text-slate-400">
              {boxes.length} detected
            </p>
          )}
          <div className="flex items-center justify-center gap-3">
            <FanMark size={22} className="animate-spin-slow shrink-0" />
            <span className="text-lg font-semibold">Identifying cards</span>
            {progress.expected != null && (
              <span className="font-mono text-sm text-slate-500">
                {progress.read}/{progress.expected}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-slate-500">
            Matching set symbols and collector numbers. You can leave this screen — it keeps
            going.
          </p>

          {/* A real bar. It used to advance on a 3.5-second timer whatever was
              happening; each segment is now one card the model has finished
              reading. */}
          {progress.expected != null && progress.expected > 0 && (
            <div className="mx-auto mt-4 flex max-w-64 gap-1">
              {Array.from({ length: progress.expected }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                    i < progress.read ? "bg-poke-red" : "bg-slate-200"
                  }`}
                />
              ))}
            </div>
          )}

          {partial.length > 0 && (
            <div className="mx-auto mt-4 max-w-sm overflow-hidden rounded-lg border border-slate-200 text-left">
              {partial.map((c, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-green-600">✓</span>
                    <span className="truncate">{c.name}</span>
                  </span>
                  {c.num && <span className="shrink-0 font-mono text-xs text-slate-400">{c.num}</span>}
                </div>
              ))}
              {progress.expected != null && progress.read < progress.expected && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-400">
                  <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-slate-300" />
                  reading…
                </div>
              )}
            </div>
          )}

          {/* Just "Cancel". It stops the WAITING, not the work: the model is
              already generating and those tokens are spent either way, so
              promising "nothing is charged" would be false — and would
              contradict what /credits tells people. The scan finishes
              server-side and stays on the job whether or not anyone watches. */}
          <button className="btn-secondary mt-5 text-sm" onClick={reset}>
            Cancel
          </button>
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
            const variant = defaultVariantFor(card, pickerRow.detected.rarityHint);
            updateRow(pickerRow.key, { card, variant, predictedVariant: variant });
            setPickerRow(null);
          }}
        />
      )}
    </div>
  );
}
