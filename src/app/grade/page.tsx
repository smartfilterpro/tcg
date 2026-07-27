"use client";

import { useEffect, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import type { GradeReport } from "@/lib/grading";

/** Downscale a photo, keeping plenty of detail — grading needs to see
 *  corners and surface texture. */
async function fileToBase64(file: File, maxDim = 2048): Promise<{ data: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return { data: dataUrl.split(",")[1], mediaType: "image/jpeg" };
}

const GRADE_STEPS = [
  `${AI_NAME} is examining both photos…`,
  "Measuring centering against the borders…",
  "Inspecting all four corners…",
  "Checking edges for whitening…",
  "Scanning the surface for scratches and print flaws…",
  "Writing up the grading report…",
];

function gradeColor(g: number): string {
  if (g >= 9) return "bg-green-600";
  if (g >= 7) return "bg-green-500";
  if (g >= 5) return "bg-yellow-500";
  if (g >= 3) return "bg-orange-500";
  return "bg-red-500";
}

function PhotoSlot({
  label,
  hint,
  file,
  setFile,
}: {
  label: string;
  hint: string;
  file: File | null;
  setFile: (f: File | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <label className="block cursor-pointer">
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setFile(f);
          e.target.value = "";
        }}
      />
      <div
        className={`flex aspect-[63/88] flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed ${
          preview ? "border-transparent" : "border-slate-300 bg-slate-50 hover:bg-slate-100"
        }`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={label} className="h-full w-full object-cover" />
        ) : (
          <div className="p-3 text-center">
            <div className="text-3xl">📷</div>
            <div className="mt-1 text-sm font-semibold">{label}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>
          </div>
        )}
      </div>
      {preview && (
        <div className="mt-1 text-center text-xs text-slate-500">
          {label} · tap to retake
        </div>
      )}
    </label>
  );
}

function SubgradeTile({ label, score, notes }: { label: string; score: number; notes: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-sm font-bold text-white ${gradeColor(score)}`}
        >
          {score}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-700">{notes}</p>
    </div>
  );
}

export default function GradePage() {
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [grading, setGrading] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<GradeReport | null>(null);
  const [gradeSeconds, setGradeSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!grading) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, GRADE_STEPS.length - 1)), 4000);
    return () => clearInterval(t);
  }, [grading]);

  async function grade() {
    if (!front || !back || grading) return;
    setGrading(true);
    setError(null);
    setReport(null);
    const startedAt = Date.now();
    try {
      const [f, b] = await Promise.all([fileToBase64(front), fileToBase64(back)]);
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ front: f, back: b }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Grading failed");
      setGradeSeconds(Math.round((Date.now() - startedAt) / 1000));
      setReport(json.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grading failed");
    }
    setGrading(false);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Card Grading</h1>
        <p className="text-sm text-slate-500">
          {AI_NAME} inspects the front and back of your card and estimates the grade it would
          likely receive, using the standards of the top grading company — centering, corners,
          edges, and surface, each explained.
        </p>
      </div>

      <div className="card-panel p-4">
        <div className="grid grid-cols-2 gap-3">
          <PhotoSlot
            label="Front"
            hint="Straight-on, whole card visible, no glare"
            file={front}
            setFile={setFront}
          />
          <PhotoSlot
            label="Back"
            hint="The back reveals edge wear best"
            file={back}
            setFile={setBack}
          />
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Tips for an accurate estimate: bright even light (no flash glare), fill the frame
          with the card, keep it flat and straight-on, and use a plain dark background.
        </p>
        <button
          className="btn-primary mt-3 w-full"
          disabled={!front || !back || grading}
          onClick={grade}
        >
          {grading ? "Grading…" : "🔎 Grade my card"}
        </button>
        {grading && (
          <div className="mt-2 flex items-center gap-2">
            <span className="animate-spin-slow inline-block h-4 w-4 shrink-0 rounded-full border-2 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
            <p className="animate-pulse text-sm text-slate-500">{GRADE_STEPS[step]}</p>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      {report && (
        <div className="card-panel space-y-4 p-4">
          {/* Headline grade */}
          <div className="flex items-center gap-4">
            <div
              className={`flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-xl text-white ${gradeColor(report.estimated_grade)}`}
            >
              <span className="text-3xl font-black leading-none">{report.estimated_grade}</span>
              <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide">
                estimate
              </span>
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

          {/* Subgrades */}
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

          {/* The grader's writeup */}
          <div>
            <h3 className="mb-1 text-sm font-semibold">📋 Grader&apos;s report</h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
              {report.summary}
            </p>
          </div>

          {(report.photo_quality.front !== "good" ||
            report.photo_quality.back !== "good" ||
            report.photo_quality.notes) && (
            <div className="rounded-lg bg-yellow-50 p-3 text-xs text-yellow-800">
              📸 Photo quality — front: {report.photo_quality.front}, back:{" "}
              {report.photo_quality.back}.{" "}
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
            This is an AI estimate for fun and planning — not an official grade. PSA, BGS, or
            CGC may grade differently after physical inspection. If the estimate is 8+ on a
            valuable card, professional grading may be worth the fee.
          </p>

          <button
            className="btn-secondary w-full text-sm"
            onClick={() => {
              setReport(null);
              setFront(null);
              setBack(null);
            }}
          >
            Grade another card
          </button>
        </div>
      )}
    </div>
  );
}
