"use client";

import type { CenteringMeasurement } from "@/lib/cardGeometry";

function mm(px: number, totalPx: number, totalMm: number): string {
  return `${((px / totalPx) * totalMm).toFixed(2)}mm`;
}

/** The flattened card with its measured borders drawn on top — the picture
 *  behind the centering number, so the measurement can be sanity-checked by
 *  eye instead of taken on faith. */
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

  return (
    <div>
      <div
        className={`relative overflow-hidden rounded-lg bg-slate-900 shadow-sm ${
          compact ? "w-[86px]" : "mx-auto max-w-[260px]"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cardDataUrl} alt={label ?? "Flattened card"} className="block w-full" />
        {measurement && (
          <>
            <div
              className={band}
              style={{ left: 0, top: 0, bottom: 0, width: `${(measurement.left / measurement.width) * 100}%` }}
            />
            <div
              className={band}
              style={{ right: 0, top: 0, bottom: 0, width: `${(measurement.right / measurement.width) * 100}%` }}
            />
            <div
              className={band}
              style={{ left: 0, right: 0, top: 0, height: `${(measurement.top / measurement.height) * 100}%` }}
            />
            <div
              className={band}
              style={{ left: 0, right: 0, bottom: 0, height: `${(measurement.bottom / measurement.height) * 100}%` }}
            />
            {/* Centre line, so a shifted card is visible at a glance */}
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/50" />
            <div className="absolute inset-x-0 top-1/2 h-px bg-white/50" />
            <span className={`${tick} left-1 top-1/2 -translate-y-1/2`}>{measurement.lr[0]}</span>
            <span className={`${tick} right-1 top-1/2 -translate-y-1/2`}>{measurement.lr[1]}</span>
            <span className={`${tick} left-1/2 top-1 -translate-x-1/2`}>{measurement.tb[0]}</span>
            <span className={`${tick} bottom-1 left-1/2 -translate-x-1/2`}>{measurement.tb[1]}</span>
          </>
        )}
      </div>

      {compact ? null : measurement ? (
        <div className="mt-2 space-y-1 text-center">
          <p className="text-sm font-semibold">
            {measurement.lr[0]}/{measurement.lr[1]} left-to-right ·{" "}
            {measurement.tb[0]}/{measurement.tb[1]} top-to-bottom
          </p>
          <p className="text-xs text-slate-500">
            Borders: {mm(measurement.left, measurement.width, 63)} /{" "}
            {mm(measurement.right, measurement.width, 63)} across,{" "}
            {mm(measurement.top, measurement.height, 88)} /{" "}
            {mm(measurement.bottom, measurement.height, 88)} down
          </p>
          <p className="text-xs font-medium text-slate-600">
            Centering alone allows up to a <strong>{measurement.cap}</strong>
          </p>
        </div>
      ) : (
        <p className="mt-2 text-center text-xs text-slate-500">
          No measurable printed border on this card (full-art or borderless), so centering is
          estimated by eye rather than measured.
        </p>
      )}
    </div>
  );
}
