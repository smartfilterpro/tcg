"use client";

// The grading write-up, laid out to artboard 12's report column. One
// implementation serves the grade you just ran and one reopened from
// history, so the two can't drift apart.

import type { ReactNode } from "react";
import type { GradeReport } from "@/lib/grading";
import type { GradeValue } from "@/lib/gradeValue";
import { CORNER_REGIONS, type CenteringMeasurement } from "@/lib/cardGeometry";
import CenteringDiagram from "@/components/CenteringDiagram";
import Markdown from "@/components/Markdown";

/** Grade → pill colour, on the artboard's thresholds. */
export function gradeColor(g: number): string {
  if (g >= 9) return "bg-[#16A34A]";
  if (g >= 7) return "bg-[#2E9E4F]";
  if (g >= 5) return "bg-[#EAB308]";
  if (g >= 3) return "bg-[#F97316]";
  return "bg-[#EF4444]";
}

/** The shared panel chrome for the report column. */
const PANEL = "rounded-[18px] border border-brand-line bg-white p-[22px]";
const PANEL_TITLE = "font-display text-base font-bold";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function SubgradeTile({ label, score, notes }: { label: string; score: number; notes: string }) {
  return (
    <div className="rounded-xl bg-brand-panel-alt p-[14px]">
      <div className="flex items-center justify-between gap-[9px]">
        <span className="min-w-0 font-mono text-[10px] font-medium uppercase tracking-[.07em] text-brand-ink4">
          {label}
        </span>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 font-display text-[13px] font-bold text-white ${gradeColor(score)}`}
        >
          {score}
        </span>
      </div>
      <p className="mt-[7px] text-[12.5px] leading-[1.55] text-brand-ink2">{notes}</p>
    </div>
  );
}

function ValuePanel({ value }: { value: GradeValue }) {
  return (
    <div className={PANEL}>
      <div className={PANEL_TITLE}>Is it worth grading?</div>
      {value.cardName && (
        <p className="mb-[14px] mt-[5px] text-[12.5px] text-brand-ink4">
          Priced as {value.cardName}
          {value.raw != null ? ` · raw about ${money(value.raw)}` : " · no raw price on file"}
        </p>
      )}
      {value.rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-brand-line">
          <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-3 bg-brand-panel-alt px-[14px] py-[9px] font-mono text-[10px] uppercase tracking-[.07em] text-brand-ink4">
            <span>If it grades</span>
            <span>Sells for</span>
            <span>vs. selling raw</span>
          </div>
          {value.rows.map((r) => (
            <div
              key={`${r.grade}-${r.tier}`}
              className={`grid grid-cols-[1.3fr_1fr_1fr] gap-3 border-t border-brand-line-soft px-[14px] py-[11px] text-[13.5px] ${
                r.likely ? "font-semibold" : ""
              }`}
            >
              <span className="min-w-0">
                {r.tier}
                {r.likely && (
                  <span className="text-[10.5px] font-normal text-brand-ink5"> (estimated)</span>
                )}
              </span>
              <span className="font-mono text-[12.5px]">{money(r.value)}</span>
              <span
                className={`font-mono text-[12.5px] ${
                  r.net >= 0 ? "text-brand-positive" : "text-brand-negative"
                }`}
              >
                {r.net >= 0 ? "+" : "−"}
                {money(Math.abs(r.net))}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-[14px] text-sm leading-[1.6] text-brand-ink2">{value.verdict}</p>
      <p className="mt-2 text-[11px] leading-[1.5] text-brand-ink5">
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
    <div className={PANEL}>
      <div className={`${PANEL_TITLE} mb-3`}>Corners, close up</div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {items.map((c) => (
          <div key={c.key} className="rounded-[10px] bg-brand-panel-alt p-[9px]">
            {c.zoom ? (
              <div
                className="aspect-square w-full rounded-md bg-brand-line bg-no-repeat"
                style={c.zoom}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.src} alt={c.label} className="aspect-square w-full rounded-md object-cover" />
            )}
            <p className="mt-[7px] font-mono text-[9px] uppercase tracking-[.06em] text-brand-ink4">
              {c.label}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-[1.45] text-brand-ink2">
              {noteFor(c.label) ?? "—"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function GradeReportView({
  report,
  value,
  measurement,
  cardImage,
  backImage,
  corners,
  meta,
  headerActions,
  headerNote,
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
  /** Buttons in the score header's top-right, per the artboard. */
  headerActions?: ReactNode;
  /** The line under the header's divider — save state, usually. */
  headerNote?: ReactNode;
  footer?: ReactNode;
}) {
  const noteFor = (label: string) =>
    report.corners.details?.find((d) => d.label.toLowerCase().includes(label.toLowerCase()))?.note;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className={PANEL}>
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={`flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-[14px] text-white ${gradeColor(report.estimated_grade)}`}
          >
            <span className="font-display text-[31px] font-bold leading-none">
              {report.estimated_grade}
            </span>
            <span className="mt-[3px] font-mono text-[8.5px] uppercase tracking-[.08em]">
              estimate
            </span>
          </div>
          <div className="min-w-0">
            <div className="font-display text-[19px] font-bold tracking-[-.02em]">
              {report.grade_label}
            </div>
            {report.card_identified && (
              <div className="mt-0.5 truncate text-sm text-brand-ink3">{report.card_identified}</div>
            )}
            <div className="mt-0.5 text-[12.5px] text-brand-ink5">
              Likely range {report.grade_range} · {report.confidence} confidence
              {meta ? ` · ${meta}` : ""}
            </div>
          </div>
          {headerActions && (
            <div className="ml-auto flex shrink-0 flex-wrap gap-2">{headerActions}</div>
          )}
        </div>
        {headerNote && (
          <div className="mt-[14px] border-t border-brand-line-soft pt-[14px] text-[12.5px]">
            {headerNote}
          </div>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
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

      <div className={PANEL}>
        <div className={`${PANEL_TITLE} mb-2`}>Grader&apos;s report</div>
        <Markdown text={report.summary} className="text-sm leading-[1.65] text-brand-ink2" />
      </div>

      {value && <ValuePanel value={value} />}

      {/* Kept out of the capture column's way: a reopened grade has no
          cropper beside it, so this is the only place the measurement and
          the flattened sides are shown at all. */}
      {cardImage && (
        <div className={PANEL}>
          <div className={`${PANEL_TITLE} mb-3`}>Centering, measured</div>
          <CenteringDiagram
            cardDataUrl={cardImage}
            measurement={measurement}
            label="Flattened front"
          />
          <p className="mt-2.5 text-[11.5px] leading-[1.55] text-brand-ink4">
            Measured from the flattened card, so the camera angle can&apos;t skew it. The shaded
            bands are the printed borders the ratio came from.
          </p>
        </div>
      )}

      {backImage && (
        <div className={PANEL}>
          <div className={`${PANEL_TITLE} mb-3`}>Back</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={backImage}
            alt="Flattened back"
            className="mx-auto max-w-[180px] rounded-[10px] border border-brand-line"
          />
        </div>
      )}

      {(report.photo_quality.front !== "good" ||
        report.photo_quality.back !== "good" ||
        report.photo_quality.notes) && (
        <div className="rounded-[14px] border border-[#F0DFA8] bg-[#FFF8E1] px-[17px] py-[15px] text-[13px] leading-[1.6] text-[#7A5A12]">
          <b>Photo quality</b> — front: {report.photo_quality.front}, back:{" "}
          {report.photo_quality.back}. {report.photo_quality.notes}
        </div>
      )}

      {report.caveats.length > 0 && (
        <div className={PANEL}>
          <div className={`${PANEL_TITLE} mb-2.5`}>What photos can&apos;t show</div>
          <div className="flex flex-col gap-2">
            {report.caveats.map((c, i) => (
              <div
                key={i}
                className="flex items-start gap-[11px] text-[13.5px] leading-[1.55] text-brand-ink2"
              >
                <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-[#B4B2AD]" />
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {footer}
    </div>
  );
}
