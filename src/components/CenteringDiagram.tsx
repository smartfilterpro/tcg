"use client";

import type { CenteringMeasurement } from "@/lib/cardGeometry";

function mm(px: number, totalPx: number, totalMm: number): string {
  return `${((px / totalPx) * totalMm).toFixed(2)}mm`;
}

/** The flattened card with its measured borders drawn on top — the picture
 *  behind the centering number, so the measurement can be sanity-checked by
 *  eye instead of taken on faith. Each direction is drawn only if it could
 *  actually be measured. */
export default function CenteringDiagram({
  cardDataUrl,
  measurement,
  label,
  compact = false,
}: {
  cardDataUrl: string;
  measurement: CenteringMeasurement | null;
  label?: string;
  /** Image and bands only — for the live preview, where the surrounding
   *  panel already carries the numbers. */
  compact?: boolean;
}) {
  const band = "absolute bg-sky-400/35 backdrop-brightness-95";
  const tick = "absolute text-[10px] font-semibold text-white drop-shadow";
  const lr = measurement?.lr ?? null;
  const tb = measurement?.tb ?? null;

  return (
    <div>
      <div
        className={`relative overflow-hidden rounded-lg bg-slate-900 shadow-sm ${
          compact ? "w-[86px]" : "mx-auto max-w-[260px]"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cardDataUrl} alt={label ?? "Flattened card"} className="block w-full" />
        {measurement && lr && (
          <>
            <div
              className={band}
              style={{ left: 0, top: 0, bottom: 0, width: `${(lr.a / measurement.width) * 100}%` }}
            />
            <div
              className={band}
              style={{ right: 0, top: 0, bottom: 0, width: `${(lr.b / measurement.width) * 100}%` }}
            />
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/50" />
            <span className={`${tick} left-1 top-1/2 -translate-y-1/2`}>{lr.pct[0]}</span>
            <span className={`${tick} right-1 top-1/2 -translate-y-1/2`}>{lr.pct[1]}</span>
          </>
        )}
        {measurement && tb && (
          <>
            <div
              className={band}
              style={{ left: 0, right: 0, top: 0, height: `${(tb.a / measurement.height) * 100}%` }}
            />
            <div
              className={band}
              style={{ left: 0, right: 0, bottom: 0, height: `${(tb.b / measurement.height) * 100}%` }}
            />
            <div className="absolute inset-x-0 top-1/2 h-px bg-white/50" />
            <span className={`${tick} left-1/2 top-1 -translate-x-1/2`}>{tb.pct[0]}</span>
            <span className={`${tick} bottom-1 left-1/2 -translate-x-1/2`}>{tb.pct[1]}</span>
          </>
        )}
      </div>

      {compact ? null : measurement ? (
        <div className="mt-2 space-y-1 text-center">
          <p className="text-sm font-semibold">
            {lr ? `${lr.pct[0]}/${lr.pct[1]} left-to-right` : "left-to-right not measurable"} ·{" "}
            {tb ? `${tb.pct[0]}/${tb.pct[1]} top-to-bottom` : "top-to-bottom not measurable"}
          </p>
          <p className="text-xs text-slate-500">
            {lr && `Side borders ${mm(lr.a, measurement.width, 63)} / ${mm(lr.b, measurement.width, 63)}`}
            {lr && tb && " · "}
            {tb &&
              `top and bottom ${mm(tb.a, measurement.height, 88)} / ${mm(tb.b, measurement.height, 88)}`}
          </p>
          <p className="text-xs font-medium text-slate-600">
            Measured centering allows up to a <strong>{measurement.cap}</strong>
          </p>
          {(!lr || !tb) && (
            <p className="text-[11px] text-slate-500">
              {(!lr ? measurement.lrNote : measurement.tbNote) ??
                `The ${lr ? "top-to-bottom" : "left-to-right"} borders couldn't be read on this card, so that direction was judged by eye.`}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-center text-xs text-slate-500">
          No border this scan can read reliably (full-art or borderless), so centering was estimated
          by eye rather than measured.
        </p>
      )}
    </div>
  );
}
