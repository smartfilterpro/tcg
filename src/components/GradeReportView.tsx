"use client";

import type { ReactNode } from "react";
import type { GradeReport } from "@/lib/grading";
import type { GradeValue } from "@/lib/gradeValue";
import { CORNER_REGIONS, type CenteringMeasurement } from "@/lib/cardGeometry";
import CenteringDiagram from "@/components/CenteringDiagram";

export function gradeColor(g: number): string {
  if (g >= 9) return "bg-green-600";
  if (g >= 7) return "bg-green-500";
  if (g >= 5) return "bg-yellow-500";
  if (g >= 3) return "bg-orange-500";
  return "bg-red-500";
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
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
        {value.raw != null ? " and the raw value you'd give up" : ""}. Graded prices were current at
        the time of grading and move around — treat them as a guide, not a quote.
      </p>
    </div>
  );
}

export interface CornerImage {
  key: string;
  label: string;
  dataUrl: string;
}

/** Corner close-ups. Fresh grades carry the high-resolution crops cut from
 *  the original photo; reopened ones zoom into the saved flattened card with
 *  CSS instead — same framing, no extra storage, and no canvas (which a
 *  cross-origin storage URL would taint anyway). */
function CornerViews({
  corners,
  cardImage,
  noteFor,
}: {
  corners?: CornerImage[];
  cardImage: string | null;
  noteFor: (label: string) => string | undefined;
}) {
  const items =
    corners && corners.length > 0
      ? corners.map((c) => ({ key: c.key, label: c.label, src: c.dataUrl, zoom: null }))
      : cardImage
        ? CORNER_REGIONS.map((r) => ({
            key: r.key,
            label: r.label,
            src: cardImage,
            zoom: {
              backgroundImage: `url(${cardImage})`,
              backgroundSize: `${(1 / (r.u1 - r.u0)) * 100}% ${(1 / (r.v1 - r.v0)) * 100}%`,
              backgroundPosition: `${r.u0 > 0 ? 100 : 0}% ${r.v0 > 0 ? 100 : 0}%`,
            } as React.CSSProperties,
          }))
        : [];
  if (items.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">🔍 Corners, close up</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((c) => (
          <div key={c.key} className="rounded-lg bg-slate-50 p-2">
            {c.zoom ? (
              <div className="aspect-square w-full rounded bg-slate-200 bg-no-repeat" style={c.zoom} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.src} alt={c.label} className="w-full rounded" />
            )}
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {c.label}
            </p>
            <p className="text-[11px] leading-snug text-slate-700">{noteFor(c.label) ?? "—"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The full grading write-up. One implementation for the grade you just ran
 *  and for one reopened from history, so the two can't drift apart. */
export default function GradeReportView({
  report,
  value,
  measurement,
  cardImage,
  backImage,
  corners,
  meta,
  footer,
}: {
  report: GradeReport;
  value: GradeValue | null;
  measurement: CenteringMeasurement | null;
  cardImage: string | null;
  backImage?: string | null;
  corners?: CornerImage[];
  /** Extra line under the card name, e.g. timing or the date it was saved. */
  meta?: string;
  footer?: ReactNode;
}) {
  const noteFor = (label: string) =>
    report.corners.details?.find((d) => d.label.toLowerCase().includes(label.toLowerCase()))?.note;

  return (
    <div className="space-y-4">
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
            {meta ? ` · ${meta}` : ""}
          </div>
        </div>
      </div>

      {cardImage && (
        <div className="rounded-lg border border-slate-200 p-3">
          <h3 className="mb-2 text-sm font-semibold">📐 Centering, measured</h3>
          <CenteringDiagram cardDataUrl={cardImage} measurement={measurement} label="Flattened front" />
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

      <CornerViews corners={corners} cardImage={cardImage} noteFor={noteFor} />

      <div>
        <h3 className="mb-1 text-sm font-semibold">📋 Grader&apos;s report</h3>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{report.summary}</p>
      </div>

      {value && <ValuePanel value={value} />}

      {backImage && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">🔄 Back</h3>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={backImage}
            alt="Flattened back"
            className="mx-auto max-w-[180px] rounded-lg border border-slate-200"
          />
        </div>
      )}

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

      {footer}
    </div>
  );
}
