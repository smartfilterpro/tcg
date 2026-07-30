"use client";

// One modal shell for the whole app.
//
// Every dialog used to carry its own hard pixel cap — max-w-md, max-w-lg,
// max-w-2xl — which meant a deck's full contents and write-up were squeezed
// into a 512px ribbon on a 2560px monitor with grey either side. The caps
// here are viewport-relative, so a dialog grows with the screen it's on and
// still behaves on a phone.
//
// Width is not the whole answer, though: a paragraph 1200px wide is harder to
// read than one at 500px, not easier. So the extra room is meant to be spent
// on LAYOUT — put things side by side, keep prose to a sane measure. `PROSE`
// below is that measure, and content columns should use it.

import { useEffect } from "react";

export type ModalSize = "sm" | "md" | "lg" | "xl";

/** Caps chosen where each kind of content stops benefiting from more room.
 *  The vw term is what makes them shrink on small screens rather than
 *  overflow. */
const SIZES: Record<ModalSize, string> = {
  /** Confirmations and short forms — more width would only stretch a sentence. */
  sm: "max-w-[min(28rem,94vw)]",
  /** A form or a single list. */
  md: "max-w-[min(44rem,94vw)]",
  /** A document: report, picker, detail view. */
  lg: "max-w-[min(60rem,94vw)]",
  /** Two columns of real content side by side. */
  xl: "max-w-[min(78rem,94vw)]",
};

/** Cap prose at a readable measure even when the dialog is much wider. */
export const PROSE = "max-w-[68ch]";

export default function Modal({
  onClose,
  size = "md",
  children,
  className,
  labelledBy,
}: {
  onClose: () => void;
  size?: ModalSize;
  children: React.ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  // Escape closes. None of the hand-rolled dialogs this replaces did that,
  // so the only way out of some of them was finding the small ✕.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // The overlay scrolls, not an inner pane: that is what keeps a tall
    // dialog reachable when a phone keyboard or pinch-zoom shifts the
    // viewport out from under a fixed-height panel.
    <div
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-brand-ink/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div
        className={`mx-auto my-6 w-full rounded-[18px] border border-brand-line bg-white p-4 shadow-xl sm:p-6 ${SIZES[size]} ${className ?? ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** The close button every dialog needs in its title row. */
export function ModalClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      aria-label="Close"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-sunken text-brand-ink4 hover:bg-brand-line hover:text-brand-ink"
      onClick={onClose}
    >
      ✕
    </button>
  );
}
