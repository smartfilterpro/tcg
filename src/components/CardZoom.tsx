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

import { useEffect, useState } from "react";

/** The same art, bigger, when the CDN serves one.
 *
 *  Callers mostly hold the thumbnail URL, and both card CDNs keep larger
 *  renders of the same file at predictable paths. Swapping here fixes every
 *  zoom surface at once; a guess that doesn't exist falls back to the
 *  original via onError, so the worst case is exactly what shipped. */
function biggerSrc(src: string): string {
  // Scryfall: .../small/front/... → .../normal/front/... (488px wide).
  if (src.includes("cards.scryfall.io/small/")) return src.replace("/small/", "/normal/");
  // pokemontcg.io: .../sv1/25.png has a _hires.png sibling.
  const m = src.match(/^(https:\/\/images\.pokemontcg\.io\/[^/]+\/[^_./]+)\.png$/);
  if (m) return `${m[1]}_hires.png`;
  return src;
}

export default function CardZoom({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [fellBack, setFellBack] = useState(false);
  const shown = fellBack ? src : biggerSrc(src);
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
        src={shown}
        alt={alt}
        onError={() => setFellBack(true)}
        // A card-sized card, whatever the screen. max-* alone let a
        // thumbnail render at its natural ~150px in the middle of a 27"
        // monitor — so this SETS the width: the viewport's width on a
        // phone, a readable 30rem on a desktop, and never taller than the
        // screen (65vh of width ≈ 91vh of card height at the 5:7 aspect).
        // The container scrolls, so pinch-zoom past the edges still works.
        className="h-auto w-[min(92vw,30rem,65vh)] rounded-xl shadow-2xl"
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
