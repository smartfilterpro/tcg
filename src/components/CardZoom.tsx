"use client";

// The card, big.
//
// Card panels show the artwork at about 160px wide, which is enough to
// recognise a card and not nearly enough to READ one — the collector number,
// the set symbol, the holo pattern, whether the copy in your hand is the one
// on the screen. All of those are questions people ask while holding the
// card, and the answer was to squint.
//
// Tap the picture, get the picture. Tap again, or press Escape, to go back.

import { useEffect } from "react";

export default function CardZoom({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  // Escape closes it. The overlay sits on top of a modal that also closes on
  // Escape, so this listener is added last and stops the event — otherwise
  // one key press would shut both and drop somebody out of the card panel
  // they were reading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-auto bg-black/85 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="dialog"
      aria-label={`${alt}, enlarged`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        // Sized to fit the screen, whichever way the phone is held. The
        // container scrolls, so a pinch-zoom past the edges still works.
        className="max-h-[92vh] max-w-full rounded-xl object-contain shadow-2xl"
      />
      <button
        className="fixed right-4 top-4 rounded-full bg-white/90 px-3 py-1.5 text-sm font-semibold text-slate-700 shadow"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        Close
      </button>
    </div>
  );
}
