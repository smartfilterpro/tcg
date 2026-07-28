"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import type { GradeReport } from "@/lib/grading";
import type { GradeValue } from "@/lib/gradeValue";
import type { CenteringMeasurement, Quad } from "@/lib/cardGeometry";
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
import type { SavedGrade } from "@/app/api/grade/reports/route";

const GRADE_STEPS = [
  "Flattening the card and measuring its borders…",
  `${AI_NAME} is examining the corner close-ups…`,
  "Checking edges for whitening…",
  "Scanning the surface for scratches and print flaws…",
  "Pricing it against graded sales…",
  "Writing up the grading report…",
];

function gradeColor(g: number): string {
  if (g >= 9) return "bg-green-600";
  if (g >= 7) return "bg-green-500";
  if (g >= 5) return "bg-yellow-500";
  if (g >= 3) return "bg-orange-500";
  return "bg-red-500";
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface SideState {
  photo: LoadedPhoto;
  quad: Quad;
  detected: boolean;
  preview: SidePreview | null;
}

function SubgradeTile({ label, score, notes }: { label: string; score: number; notes: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-sm font-bold text-white ${gradeColor(score)}`}>
          {score}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-700">{notes}</p>
    </div>
  );
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
        <div className="flex gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={side.preview.cardDataUrl}
            alt={`${label} flattened`}
            className="h-24 w-auto rounded border border-slate-200"
          />
          <div className="min-w-0 text-[11px] leading-relaxed text-slate-600">
            <p className="font-semibold text-slate-700">Flattened</p>
            {m ? (
              <p>
                Centering {m.lr[0]}/{m.lr[1]} · {m.tb[0]}/{m.tb[1]}
                <br />
                allows up to a <strong>{m.cap}</strong>
              </p>
            ) : (
              <p>No printed border to measure.</p>
            )}
            {metrics?.blurry && <p className="text-amber-600">Looks soft — a sharper photo grades better.</p>}
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

function ValuePanel({ value }: { value: GradeValue }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 text-sm font-semibold">💰 Is it worth grading?</h3>
      {value.cardName && (
        <p className="mb-2 text-xs text-slate-500">
          Priced as {value.cardName}
          {value.raw != null ? ` · raw about ${money(value.raw)}` : " · no raw price on file"}
        </p>
      )}
      {value.rows.length > 0 && (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[320px] text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="px-1 py-1 font-medium">If it grades</th>
                <th className="px-1 py-1 font-medium">Sells for</th>
                <th className="px-1 py-1 font-medium">vs. selling raw</th>
              </tr>
            </thead>
            <tbody>
              {value.rows.map((r) => (
                <tr key={`${r.grade}-${r.tier}`} className={r.likely ? "font-semibold" : ""}>
                  <td className="px-1 py-1">
                    {r.tier}
                    {r.likely && <span className="ml-1 text-[10px] text-slate-400">(estimated)</span>}
                  </td>
                  <td className="px-1 py-1">{money(r.value)}</td>
                  <td className={`px-1 py-1 ${r.net >= 0 ? "text-green-700" : "text-red-600"}`}>
                    {r.net >= 0 ? "+" : "−"}
                    {money(Math.abs(r.net))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs leading-relaxed text-slate-700">{value.verdict}</p>
      <p className="mt-1 text-[10px] text-slate-400">
        Net figures subtract the {money(value.fee)} grading fee
        {value.raw != null ? " and the raw value you'd give up" : ""}. Graded prices come from the
        last price refresh and move around — treat them as a guide, not a quote.
      </p>
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
  const [historyOpen, setHistoryOpen] = useState(false);
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

  // Re-measure shortly after the corners stop moving: instant feedback
  // without recomputing the warp on every pointer event.
  function updateQuad(which: "front" | "back", quad: Quad) {
    const setter = which === "front" ? setFront : setBack;
    setter((s) => (s ? { ...s, quad } : s));
  }

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

  const cornerNote = (label: string) =>
    report?.corners.details?.find((d) => d.label.toLowerCase().includes(label.toLowerCase()))?.note;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Card Grading</h1>
        <p className="text-sm text-slate-500">
          Place the card&apos;s corners, and PokéDeck flattens out the camera angle, measures the
          borders in software, and has {AI_NAME} judge the corners, edges and surface from
          close-ups — then tells you whether grading it would actually pay.
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
        <div className="card-panel space-y-4 p-4">
          <div className="flex items-center gap-4">
            <div
              className={`flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-xl text-white ${gradeColor(report.estimated_grade)}`}
            >
              <span className="text-3xl font-black leading-none">{report.estimated_grade}</span>
              <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide">estimate</span>
            </div>
            <div className="min-w-0">
              <div className="text-lg font-bold">{report.grade_label}</div>
              {report.card_identified && (
                <div className="truncate text-sm text-slate-500">{report.card_identified}</div>
              )}
              <div className="text-xs text-slate-400">
                Likely range {report.grade_range} · {report.confidence} confidence
                {gradeSeconds != null ? ` · graded in ${gradeSeconds}s` : ""}
              </div>
            </div>
          </div>

          {/* The measured centering, drawn on the flattened card */}
          {shown && (
            <div className="rounded-lg border border-slate-200 p-3">
              <h3 className="mb-2 text-sm font-semibold">📐 Centering, measured</h3>
              <CenteringDiagram
                cardDataUrl={shown.front.cardDataUrl}
                measurement={shown.front.measurement}
                label="Flattened front"
              />
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                Measured from the flattened card, so the camera angle can&apos;t skew it. The shaded
                bands are the printed borders the ratio came from.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <SubgradeTile
              label={`Centering · ${report.centering.estimate}`}
              score={report.centering.score}
              notes={report.centering.notes}
            />
            <SubgradeTile label="Corners" score={report.corners.score} notes={report.corners.notes} />
            <SubgradeTile label="Edges" score={report.edges.score} notes={report.edges.notes} />
            <SubgradeTile label="Surface" score={report.surface.score} notes={report.surface.notes} />
          </div>

          {/* Corner close-ups beside what the grader said about each one */}
          {shown && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">🔍 Corners, close up</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {shown.front.corners.map((c) => (
                  <div key={c.key} className="rounded-lg bg-slate-50 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.dataUrl} alt={`Front ${c.label}`} className="w-full rounded" />
                    <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      {c.label}
                    </p>
                    <p className="text-[11px] leading-snug text-slate-700">
                      {cornerNote(c.label) ?? "—"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-1 text-sm font-semibold">📋 Grader&apos;s report</h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{report.summary}</p>
          </div>

          {value && <ValuePanel value={value} />}

          {(report.photo_quality.front !== "good" ||
            report.photo_quality.back !== "good" ||
            report.photo_quality.notes) && (
            <div className="rounded-lg bg-yellow-50 p-3 text-xs text-yellow-800">
              📸 Photo quality — front: {report.photo_quality.front}, back: {report.photo_quality.back}.{" "}
              {report.photo_quality.notes}
            </div>
          )}

          {report.caveats.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold">⚠️ What photos can&apos;t show</h3>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-slate-600">
                {report.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">
            This is an AI estimate for fun and planning — not an official grade. PSA, BGS, or CGC may
            grade differently after physical inspection.{" "}
            {saveState === "saved" && "Saved to your grading history."}
            {saveState === "saving" && "Saving…"}
            {saveState === "failed" && `Not saved — ${saveError}`}
          </p>

          <button className="btn-secondary w-full text-sm" onClick={reset}>
            Grade another card
          </button>
        </div>
      )}

      {history && history.length > 0 && (
        <div className="card-panel p-4">
          <button
            className="flex w-full items-center justify-between text-sm font-semibold"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <span>🗂️ Grading history ({history.length})</span>
            <span className="text-slate-400">{historyOpen ? "▲" : "▼"}</span>
          </button>
          {historyOpen && (
            <ul className="mt-3 space-y-2">
              {history.map((g) => (
                <li key={g.id} className="flex items-center gap-3 rounded-lg bg-slate-50 p-2">
                  {g.frontUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={g.frontUrl} alt="" className="h-14 w-auto rounded" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{g.cardName ?? "Unidentified card"}</p>
                    <p className="text-[11px] text-slate-500">
                      {new Date(g.createdAt).toLocaleDateString()} ·{" "}
                      {g.report?.centering?.estimate ?? ""}
                    </p>
                  </div>
                  {g.estimatedGrade != null && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-sm font-bold text-white ${gradeColor(g.estimatedGrade)}`}
                    >
                      {g.estimatedGrade}
                    </span>
                  )}
                  <button
                    className="text-xs text-slate-400 hover:text-red-600"
                    aria-label="Delete saved grade"
                    onClick={async () => {
                      await fetch(`/api/grade/reports?id=${g.id}`, { method: "DELETE" });
                      loadHistory();
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
