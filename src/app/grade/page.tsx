"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import type { GradeReport } from "@/lib/grading";
import type { GradeValue } from "@/lib/gradeValue";
import { quadNearEdge, type CenteringMeasurement, type Quad } from "@/lib/cardGeometry";
import {
  loadPhoto,
  initialQuad,
  previewSide,
  prepareSide,
  type LoadedPhoto,
  type PreparedSide,
  type SidePreview,
} from "@/lib/cardImage";
import { uploadCardPhoto } from "@/lib/photos";
import CardCropper from "@/components/CardCropper";
import CenteringDiagram from "@/components/CenteringDiagram";
import GradeReportView, { gradeColor } from "@/components/GradeReportView";
import type { SavedGrade } from "@/app/api/grade/reports/route";

const GRADE_STEPS = [
  "Flattening the card and measuring its borders…",
  `${AI_NAME} is examining the corner close-ups…`,
  "Checking edges for whitening…",
  "Scanning the surface for scratches and print flaws…",
  "Pricing it against graded sales…",
  "Writing up the grading report…",
];

interface SideState {
  photo: LoadedPhoto;
  quad: Quad;
  detected: boolean;
  preview: SidePreview | null;
}

/** One photo: empty slot, or the cropper plus its live flattened preview. */
function SidePanel({
  label,
  hint,
  side,
  onFile,
  onQuad,
  onRedetect,
}: {
  label: string;
  hint: string;
  side: SideState | null;
  onFile: (f: File) => void;
  onQuad: (q: Quad) => void;
  onRedetect: () => void;
}) {
  if (!side) {
    return (
      <label className="block cursor-pointer">
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <div className="flex aspect-[63/88] flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100">
          <div className="text-3xl">📷</div>
          <div className="mt-1 text-sm font-semibold">{label}</div>
          <div className="mt-0.5 px-3 text-center text-[11px] text-slate-400">{hint}</div>
        </div>
      </label>
    );
  }

  const m = side.preview?.measurement ?? null;
  const metrics = side.preview?.metrics;
  const nearEdge = quadNearEdge(side.quad, side.photo.width, side.photo.height);
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold">{label}</div>
      <CardCropper
        photo={side.photo}
        quad={side.quad}
        onChange={onQuad}
        onRedetect={onRedetect}
        detected={side.detected}
      />
      {side.preview && (
        <div className="flex gap-3 rounded-lg bg-slate-50 p-2">
          <CenteringDiagram
            compact
            cardDataUrl={side.preview.cardDataUrl}
            measurement={m}
            label={`${label} flattened`}
          />
          <div className="min-w-0 text-[11px] leading-relaxed text-slate-600">
            <p className="font-semibold text-slate-700">This is what gets graded</p>
            {m ? (
              <>
                <p>
                  Centering {m.lr[0]}/{m.lr[1]} · {m.tb[0]}/{m.tb[1]} — allows up to a{" "}
                  <strong>{m.cap}</strong>
                </p>
                <p className="text-slate-400">
                  The blue bands should sit exactly on the printed border. If they don&apos;t, nudge
                  the corners.
                </p>
              </>
            ) : (
              <p>
                No measurable printed border (full-art or borderless), so centering will be judged
                by eye instead.
              </p>
            )}
            {nearEdge && (
              <p className="text-amber-600">
                The card fills the frame — leave a little space around it so it can be found
                reliably.
              </p>
            )}
            {metrics?.blurry && (
              <p className="text-amber-600">Looks soft — a sharper photo grades better.</p>
            )}
            {metrics?.glary && <p className="text-amber-600">Glare detected — try even, indirect light.</p>}
          </div>
        </div>
      )}
      <label className="block">
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <span className="btn-secondary inline-block cursor-pointer px-2 py-1 text-xs">↺ Retake</span>
      </label>
    </div>
  );
}

/** A saved grade, reopened. Scrolls the whole overlay rather than a fixed
 *  panel, which is what keeps it on screen when a phone keyboard or zoom
 *  shifts the viewport. */
function SavedGradeModal({
  grade,
  onClose,
  onDelete,
}: {
  grade: SavedGrade;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4" onClick={onClose}>
      <div
        className="mx-auto my-4 max-w-2xl rounded-xl bg-white p-4 shadow-xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">{grade.cardName ?? "Saved grade"}</h2>
            <p className="text-xs text-slate-400">
              Graded {new Date(grade.createdAt).toLocaleString()}
            </p>
          </div>
          <button className="shrink-0 text-xl leading-none text-slate-400 hover:text-slate-700" onClick={onClose}>
            ✕
          </button>
        </div>

        <GradeReportView
          report={grade.report}
          value={grade.value}
          measurement={grade.measurement}
          cardImage={grade.frontUrl}
          backImage={grade.backUrl}
          meta={`saved ${new Date(grade.createdAt).toLocaleDateString()}`}
          footer={
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              <button className="btn-secondary text-sm" onClick={onClose}>
                Close
              </button>
              <button
                className="text-sm text-red-600 hover:underline"
                onClick={() => {
                  if (confirm("Delete this saved grade?")) onDelete();
                }}
              >
                Delete this grade
              </button>
            </div>
          }
        />
      </div>
    </div>
  );
}

export default function GradePage() {
  const [front, setFront] = useState<SideState | null>(null);
  const [back, setBack] = useState<SideState | null>(null);
  const [grading, setGrading] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<GradeReport | null>(null);
  const [value, setValue] = useState<GradeValue | null>(null);
  const [shown, setShown] = useState<{ front: PreparedSide; back: PreparedSide } | null>(null);
  const [gradeSeconds, setGradeSeconds] = useState<number | null>(null);
  const [fee, setFee] = useState(25);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [history, setHistory] = useState<SavedGrade[] | null>(null);
  const [openGrade, setOpenGrade] = useState<SavedGrade | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  useEffect(() => {
    if (!grading) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, GRADE_STEPS.length - 1)), 5000);
    return () => clearInterval(t);
  }, [grading]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/grade/reports");
      const json = await res.json();
      setHistory(json.grades ?? []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function pickFile(which: "front" | "back", file: File) {
    const setter = which === "front" ? setFront : setBack;
    try {
      const photo = await loadPhoto(file);
      urlsRef.current.push(photo.url);
      const { quad, detected } = initialQuad(photo);
      setter({ photo, quad, detected, preview: previewSide(photo, quad) });
    } catch {
      setError("That photo couldn't be opened — try another.");
    }
  }

  function updateQuad(which: "front" | "back", quad: Quad) {
    const setter = which === "front" ? setFront : setBack;
    setter((s) => (s ? { ...s, quad } : s));
  }

  // Re-measure shortly after the corners stop moving: instant feedback
  // without recomputing the warp on every pointer event.
  useEffect(() => {
    if (!front) return;
    const t = setTimeout(
      () => setFront((s) => (s ? { ...s, preview: previewSide(s.photo, s.quad) } : s)),
      250
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [front?.quad]);

  useEffect(() => {
    if (!back) return;
    const t = setTimeout(
      () => setBack((s) => (s ? { ...s, preview: previewSide(s.photo, s.quad) } : s)),
      250
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back?.quad]);

  function redetect(which: "front" | "back") {
    const setter = which === "front" ? setFront : setBack;
    setter((s) => {
      if (!s) return s;
      const { quad, detected } = initialQuad(s.photo);
      return { ...s, quad, detected, preview: previewSide(s.photo, quad) };
    });
  }

  async function saveGrade(
    rep: GradeReport,
    val: GradeValue | null,
    measurement: CenteringMeasurement | null,
    prepared: { front: PreparedSide; back: PreparedSide }
  ) {
    setSaveState("saving");
    setSaveError(null);
    try {
      const [frontUrl, backUrl] = await Promise.all([
        uploadCardPhoto(prepared.front.cardBlob),
        uploadCardPhoto(prepared.back.cardBlob),
      ]);
      const res = await fetch("/api/grade/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report: rep,
          value: val,
          measurement,
          cardId: val?.cardId ?? null,
          cardName: val?.cardName ?? rep.card_identified,
          frontUrl,
          backUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSaveState("saved");
      loadHistory();
    } catch (e) {
      setSaveState("failed");
      setSaveError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function grade() {
    if (!front || !back || grading) return;
    setGrading(true);
    setError(null);
    setReport(null);
    setValue(null);
    setSaveState("idle");
    const startedAt = Date.now();
    try {
      const [f, b] = await Promise.all([
        prepareSide(front.photo, front.quad),
        prepareSide(back.photo, back.quad),
      ]);
      if (!f || !b) throw new Error("Couldn't flatten the card — try replacing the corners.");
      setShown({ front: f, back: b });

      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fee,
          front: {
            card: { data: f.cardBase64, mediaType: "image/jpeg" },
            corners: f.corners.map((c) => ({ label: c.label, data: c.base64, mediaType: "image/jpeg" })),
            centering: f.measurement,
          },
          back: {
            card: { data: b.cardBase64, mediaType: "image/jpeg" },
            corners: b.corners.map((c) => ({ label: c.label, data: c.base64, mediaType: "image/jpeg" })),
            centering: b.measurement,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Grading failed");
      setGradeSeconds(Math.round((Date.now() - startedAt) / 1000));
      setReport(json.report);
      setValue(json.value ?? null);
      saveGrade(json.report, json.value ?? null, f.measurement, { front: f, back: b });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grading failed");
    }
    setGrading(false);
  }

  function reset() {
    setReport(null);
    setValue(null);
    setShown(null);
    setFront(null);
    setBack(null);
    setSaveState("idle");
  }

  async function deleteGrade(id: string) {
    await fetch(`/api/grade/reports?id=${id}`, { method: "DELETE" });
    setOpenGrade(null);
    loadHistory();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Card Grading</h1>
        <p className="text-sm text-slate-500">
          Place the card&apos;s corners, and PokéDeck flattens out the camera angle, measures the
          borders in software, and has {AI_NAME} judge the corners, edges and surface from
          close-ups — then tells you whether grading it would actually pay. Every grade is kept, so
          you can come back to it.
        </p>
      </div>

      {!report && (
        <div className="card-panel space-y-4 p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SidePanel
              label="Front"
              hint="Whole card visible, bright even light"
              side={front}
              onFile={(f) => pickFile("front", f)}
              onQuad={(q) => updateQuad("front", q)}
              onRedetect={() => redetect("front")}
            />
            <SidePanel
              label="Back"
              hint="The back reveals edge wear best"
              side={back}
              onFile={(f) => pickFile("back", f)}
              onQuad={(q) => updateQuad("back", q)}
              onRedetect={() => redetect("back")}
            />
          </div>

          <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>Grading fee per card</span>
            <span className="flex items-center gap-1">
              $
              <input
                type="number"
                min={0}
                max={500}
                step={1}
                value={fee}
                onChange={(e) => setFee(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                className="w-20 rounded border border-slate-300 px-2 py-1"
              />
            </span>
            <span className="text-slate-400">used for the &ldquo;worth it?&rdquo; maths</span>
          </label>

          <button className="btn-primary w-full" disabled={!front || !back || grading} onClick={grade}>
            {grading ? "Grading…" : "🔎 Grade my card"}
          </button>
          {grading && (
            <div className="flex items-center gap-2">
              <span className="animate-spin-slow inline-block h-4 w-4 shrink-0 rounded-full border-2 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
              <p className="animate-pulse text-sm text-slate-500">{GRADE_STEPS[step]}</p>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {report && (
        <div className="card-panel p-4">
          <GradeReportView
            report={report}
            value={value}
            measurement={shown?.front.measurement ?? null}
            cardImage={shown?.front.cardDataUrl ?? null}
            corners={shown?.front.corners}
            meta={gradeSeconds != null ? `graded in ${gradeSeconds}s` : undefined}
            footer={
              <>
                <p className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">
                  This is an AI estimate for fun and planning — not an official grade. PSA, BGS, or
                  CGC may grade differently after physical inspection.
                </p>
                {saveState === "saved" && (
                  <p className="text-xs text-green-700">✓ Saved — it&apos;s in your grading history below.</p>
                )}
                {saveState === "saving" && <p className="text-xs text-slate-400">Saving…</p>}
                {saveState === "failed" && (
                  <div className="rounded-lg bg-yellow-50 p-3 text-xs text-yellow-800">
                    <p>Couldn&apos;t save this grade — {saveError}</p>
                    <button
                      className="btn-secondary mt-2 px-2 py-1 text-xs"
                      onClick={() =>
                        shown && report && saveGrade(report, value, shown.front.measurement, shown)
                      }
                    >
                      💾 Try saving again
                    </button>
                  </div>
                )}
                <button className="btn-secondary w-full text-sm" onClick={reset}>
                  Grade another card
                </button>
              </>
            }
          />
        </div>
      )}

      {history && history.length > 0 && (
        <div className="card-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">🗂️ Grading history</h2>
          <p className="mb-3 text-[11px] text-slate-400">
            Tap any card to reopen its full report.
          </p>
          <ul className="space-y-2">
            {history.map((g) => (
              <li key={g.id}>
                <button
                  className="flex w-full items-center gap-3 rounded-lg bg-slate-50 p-2 text-left hover:bg-slate-100"
                  onClick={() => setOpenGrade(g)}
                >
                  {g.frontUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={g.frontUrl} alt="" className="h-14 w-auto rounded" />
                  ) : (
                    <span className="flex h-14 w-10 items-center justify-center rounded bg-slate-200 text-slate-400">
                      🎴
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {g.cardName ?? "Unidentified card"}
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      {new Date(g.createdAt).toLocaleDateString()}
                      {g.report?.centering?.estimate ? ` · ${g.report.centering.estimate}` : ""}
                    </span>
                  </span>
                  {g.estimatedGrade != null && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-sm font-bold text-white ${gradeColor(g.estimatedGrade)}`}
                    >
                      {g.estimatedGrade}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {openGrade && (
        <SavedGradeModal
          grade={openGrade}
          onClose={() => setOpenGrade(null)}
          onDelete={() => deleteGrade(openGrade.id)}
        />
      )}
    </div>
  );
}
