"use client";

import { useRef, useState } from "react";
import type { LoadedPhoto } from "@/lib/cardImage";
import type { Point, Quad } from "@/lib/cardGeometry";

const CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];

/** How much of the photo the magnifier shows, and how big it is on screen. */
const LOUPE_PX = 116;
const LOUPE_FRACTION = 0.14;

/** A magnifier for the corner being dragged. On a phone your fingertip
 *  covers the exact spot you're trying to hit, so without this you're
 *  placing the corner blind. */
function Loupe({ photo, point, side }: { photo: LoadedPhoto; point: Point; side: "left" | "right" }) {
  const bgW = LOUPE_PX / LOUPE_FRACTION;
  const bgH = bgW * (photo.height / photo.width);
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 overflow-hidden rounded-full border-2 border-white bg-slate-800 shadow-lg"
      style={{
        width: LOUPE_PX,
        height: LOUPE_PX,
        [side]: 8,
        backgroundImage: `url(${photo.url})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${bgW}px ${bgH}px`,
        backgroundPosition: `${LOUPE_PX / 2 - (point.x / photo.width) * bgW}px ${
          LOUPE_PX / 2 - (point.y / photo.height) * bgH
        }px`,
      }}
    >
      {/* Crosshair marking the exact point being placed */}
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-sky-300/80" />
      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-sky-300/80" />
      <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-300 bg-transparent" />
    </div>
  );
}

/** Place the card's four corners on a photo. Auto-detection gets this right
 *  most of the time, but centering is measured from these points — so the
 *  handles are always there, and a bad detection is a few seconds' fix
 *  instead of a wrong grade. */
export default function CardCropper({
  photo,
  quad,
  onChange,
  onRedetect,
  detected,
  actions,
}: {
  photo: LoadedPhoto;
  quad: Quad;
  onChange: (q: Quad) => void;
  onRedetect: () => void;
  detected: boolean;
  /** Sits beside Auto-detect, so the artboard's pair of buttons is one row
   *  even though Retake belongs to the caller. */
  actions?: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  function pointFromEvent(e: React.PointerEvent): Point | null {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    // A photo with no measured size yet turns every coordinate into NaN,
    // which then travels out through onChange into the caller's geometry
    // and into CSS as "NaN%". Refusing to produce the point is the honest
    // response: the drag does nothing for a frame instead of poisoning the
    // quad.
    if (!(photo.width > 0) || !(photo.height > 0)) return null;
    const x = ((e.clientX - rect.left) / rect.width) * photo.width;
    const y = ((e.clientY - rect.top) / rect.height) * photo.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
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

  // Percentages, with a safe value for anything that isn't a real number.
  // These land in clip-path, and one NaN there silently voids the whole
  // declaration — the dimming and the outline vanish with no error.
  const safePct = (value: number, span: number) => {
    const n = span > 0 ? (value / span) * 100 : 0;
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  };

  const pct = (p: Point) => ({
    left: `${safePct(p?.x ?? 0, photo.width)}%`,
    top: `${safePct(p?.y ?? 0, photo.height)}%`,
  });

  const polygon = quad
    .map((p) => `${safePct(p?.x ?? 0, photo.width)}% ${safePct(p?.y ?? 0, photo.height)}%`)
    .join(", ");

  // The dragged corner, read ONCE and defensively.
  //
  // Two places used to reach for quad[dragging] and dereference it straight
  // away. If that index is ever momentarily absent — the parent swapping in
  // a fresh quad, a re-detect landing mid-drag — the read throws, and a
  // throw during render takes the entire page down with "a client-side
  // exception has occurred". A dropped handle is a recoverable annoyance;
  // losing the grade screen is not, so nothing here assumes the index is
  // still good.
  const activePoint = dragging != null ? quad[dragging] : undefined;

  // Keep the magnifier away from the finger: show it on the opposite side
  // of the corner being dragged.
  const loupeSide: "left" | "right" =
    activePoint && activePoint.x < photo.width / 2 ? "right" : "left";

  return (
    <div>
      <div ref={boxRef} className="relative touch-none select-none overflow-hidden rounded-xl bg-slate-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url} alt="Card photo" className="block w-full" draggable={false} />
        {/* Everything outside the placed quad dims, so it's obvious what
            will be measured and what is just table. */}
        <div
          className="pointer-events-none absolute inset-0 bg-slate-900/65"
          style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${polygon}, 0 0)` }}
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{ clipPath: `polygon(${polygon})`, boxShadow: "inset 0 0 0 2px rgba(56,189,248,0.95)" }}
        />

        {quad.map((p, i) => {
          const active = dragging === i;
          return (
            <button
              key={i}
              type="button"
              aria-label={`Move the ${CORNER_NAMES[i]} corner`}
              className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center"
              style={pct(p)}
              onPointerDown={(e) => {
                e.preventDefault();
                // Capture keeps the drag alive when the finger leaves the
                // 44px handle, which it always does. It throws if the
                // element has already gone, and an exception in a pointer
                // handler is the same page-killing crash as one in render.
                try {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } catch {
                  /* dragging still works, just without capture */
                }
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
              {/* Ticks point at the exact spot from four sides, leaving the
                  centre itself clear so the corner stays visible. */}
              <span className="pointer-events-none absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-white" />
              <span className="pointer-events-none absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-white" />
              <span className="pointer-events-none absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-white" />
              <span className="pointer-events-none absolute right-0 top-1/2 h-px w-3 -translate-y-1/2 bg-white" />
              <span
                className={`pointer-events-none block rounded-full border-2 transition ${
                  active
                    ? "h-6 w-6 border-sky-300 bg-sky-400/25"
                    : "h-5 w-5 border-white bg-sky-400/20"
                }`}
              />
            </button>
          );
        })}

        {activePoint && <Loupe photo={photo} point={activePoint} side={loupeSide} />}
      </div>

      <div className="mt-2.5 space-y-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium hover:bg-brand-sunken"
            onClick={onRedetect}
          >
            ✧ Auto-detect
          </button>
          {actions}
        </div>
        <p className="text-[11px] leading-relaxed text-brand-ink4">
          {detected
            ? "Corners found automatically. "
            : "Couldn't find the card automatically. "}
          Each handle marks <strong>one corner of the card</strong> — put the middle of the circle
          right on the corner tip. The shaded area is thrown away; only what&apos;s inside the blue
          outline gets measured.
        </p>
      </div>
    </div>
  );
}
