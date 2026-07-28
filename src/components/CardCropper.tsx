"use client";

import { useRef, useState } from "react";
import type { LoadedPhoto } from "@/lib/cardImage";
import type { Point, Quad } from "@/lib/cardGeometry";

const CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];

/** Place the card's four corners on a photo. Auto-detection gets this right
 *  most of the time, but centering is measured from these points — so the
 *  handles are always there, and a bad detection is a two-second fix
 *  instead of a wrong grade. */
export default function CardCropper({
  photo,
  quad,
  onChange,
  onRedetect,
  detected,
}: {
  photo: LoadedPhoto;
  quad: Quad;
  onChange: (q: Quad) => void;
  onRedetect: () => void;
  detected: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  function pointFromEvent(e: React.PointerEvent): Point | null {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * photo.width;
    const y = ((e.clientY - rect.top) / rect.height) * photo.height;
    return {
      x: Math.max(0, Math.min(photo.width, x)),
      y: Math.max(0, Math.min(photo.height, y)),
    };
  }

  function move(index: number, e: React.PointerEvent) {
    const p = pointFromEvent(e);
    if (!p) return;
    const next = [...quad] as Quad;
    next[index] = p;
    onChange(next);
  }

  const pct = (p: Point) => ({
    left: `${(p.x / photo.width) * 100}%`,
    top: `${(p.y / photo.height) * 100}%`,
  });

  const polygon = quad.map((p) => `${(p.x / photo.width) * 100}% ${(p.y / photo.height) * 100}%`).join(", ");

  return (
    <div>
      <div ref={boxRef} className="relative touch-none select-none overflow-hidden rounded-xl bg-slate-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url} alt="Card photo" className="block w-full" draggable={false} />
        {/* Everything outside the placed quad dims, so it's obvious what will
            be measured and what is just table. */}
        <div
          className="pointer-events-none absolute inset-0 bg-slate-900/60"
          style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${polygon}, 0 0)` }}
        />
        <div
          className="pointer-events-none absolute inset-0 border-0"
          style={{
            clipPath: `polygon(${polygon})`,
            boxShadow: "inset 0 0 0 2px rgba(56,189,248,0.9)",
          }}
        />
        {quad.map((p, i) => (
          <button
            key={i}
            aria-label={`Move ${CORNER_NAMES[i]} corner`}
            className={`absolute h-9 w-9 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 transition ${
              dragging === i
                ? "scale-110 border-white bg-sky-400/70"
                : "border-white bg-sky-400/40 hover:bg-sky-400/60"
            }`}
            style={pct(p)}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setDragging(i);
            }}
            onPointerMove={(e) => {
              if (dragging === i) move(i, e);
            }}
            onPointerUp={(e) => {
              if (dragging === i) move(i, e);
              setDragging(null);
            }}
            onPointerCancel={() => setDragging(null)}
          >
            <span className="pointer-events-none block h-1.5 w-1.5 translate-x-[13px] translate-y-[13px] rounded-full bg-white" />
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">
          {detected
            ? "Corners found automatically — drag any that missed."
            : "Couldn't find the card automatically — drag the four handles onto its corners."}
        </p>
        <button className="btn-secondary px-2 py-1 text-xs" onClick={onRedetect}>
          ↻ Auto-detect
        </button>
      </div>
    </div>
  );
}
