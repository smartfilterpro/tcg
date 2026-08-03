"use client";

import { useState } from "react";

export interface DeckEditChange {
  name: string;
  from: number;
  to: number;
  reason?: string | null;
}

export interface DeckEditProposal {
  deckId: string;
  deckName: string;
  changes: DeckEditChange[];
}

/** The approval card for a proposed deck edit.
 *
 *  Shows the whole diff before anything happens. The model wrote the
 *  numbers; the player decides; the server checks again on the way in. A
 *  card removed reads as a removal rather than "→ 0", because that is what
 *  it is.
 *
 *  Shared by the TrainerAI panel and the coach box under a saved deck. Both
 *  post to the same apply route, so the approval means the same thing and is
 *  checked the same way wherever it is pressed. */
export default function DeckEditCard({
  proposal,
  onApplied,
}: {
  proposal: DeckEditProposal;
  /** Fired after a successful write, so a screen that is displaying the deck
   *  can reload it. Without this the coach box would sit under a card list
   *  that no longer matches the deck it just changed. */
  onApplied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "declined">("idle");
  const [note, setNote] = useState<string | null>(null);

  async function apply() {
    setState("busy");
    setNote(null);
    try {
      const res = await fetch("/api/decks/apply-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId: proposal.deckId, changes: proposal.changes }),
      });
      const json = await res.json();
      if (!res.ok) {
        // The server re-validates, so a refusal here is real and worth
        // reading — not a generic failure.
        setNote([json.error, ...(json.reasons ?? [])].filter(Boolean).join(" "));
        setState("idle");
        return;
      }
      setNote(json.message ?? "Deck updated.");
      setState("done");
      onApplied?.();
    } catch {
      setNote("Couldn't reach the server — nothing was changed.");
      setState("idle");
    }
  }

  return (
    <div className="mt-2 rounded-[12px] border border-brand-line bg-brand-sunken p-3">
      <div className="text-[12.5px] font-semibold text-brand-ink2">
        Change &ldquo;{proposal.deckName}&rdquo;?
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {proposal.changes.map((c) => (
          <div key={c.name} className="flex items-baseline gap-2 text-[12.5px]">
            <span
              className={`w-4 shrink-0 text-center font-mono ${
                c.to === 0 || c.to < c.from ? "text-brand-negative" : "text-brand-positive"
              }`}
            >
              {c.to === 0 ? "✕" : c.to > c.from ? "+" : "−"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{c.name}</span>{" "}
              <span className="text-brand-ink4">
                {c.to === 0 ? "removed" : `${c.from} → ${c.to}`}
              </span>
              {c.reason && (
                <span className="block text-[11.5px] leading-snug text-brand-ink4">{c.reason}</span>
              )}
            </span>
          </div>
        ))}
      </div>

      {state === "done" ? (
        <p className="m-0 mt-2.5 text-[12px] text-brand-positive">✓ {note}</p>
      ) : state === "declined" ? (
        <p className="m-0 mt-2.5 text-[12px] text-brand-ink4">Left alone.</p>
      ) : (
        <>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-[12.5px]"
              disabled={state === "busy"}
              onClick={apply}
            >
              {state === "busy" ? "Applying…" : "Apply to deck"}
            </button>
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-[12.5px]"
              disabled={state === "busy"}
              onClick={() => setState("declined")}
            >
              No thanks
            </button>
          </div>
          {note && <p className="m-0 mt-2 text-[12px] text-brand-negative">{note}</p>}
        </>
      )}
    </div>
  );
}
