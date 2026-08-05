"use client";

// What a card actually does, rendered.
//
// The deck viewer has been able to show a card's abilities, attacks and rules
// for a while. The collection could not — you could stand on a card's own
// page, looking at a picture too small to read on a phone, and the one thing
// the screen would not tell you is what the card DOES. Everything needed was
// already there: the text is on the card row, and /api/cards/details already
// serves it and fills the gaps.
//
// So this is the deck viewer's markup lifted out whole, plus the fetching, so
// both screens read the same and neither can drift into being the good one.

import { useEffect, useState } from "react";
import type { CardDetail } from "@/app/api/cards/details/route";

/** Fetch one card's printed text by id.
 *
 *  Null while there is nothing to ask about, so a modal that hasn't been
 *  opened yet costs no request. The endpoint fills its own gaps from the free
 *  card databases and caches what it finds, so the second person to open a
 *  card pays nothing for it. */
export function useCardText(cardId: string | null | undefined) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cardId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/cards/details?ids=${encodeURIComponent(cardId)}`);
        const json = await res.json();
        if (!cancelled && res.ok) setDetail(json.byId?.[cardId] ?? null);
      } catch {
        // The sheet says it couldn't find the text rather than pretending.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  return { detail, loading };
}

/** True when we have a record but it carries no printed text at all. Basic
 *  Energy is the honest case; everything else is a gap. */
export function hasNoText(d: CardDetail | null | undefined): boolean {
  return !!d && d.attacks.length === 0 && d.abilities.length === 0 && d.rules.length === 0;
}

/** The abilities, attacks and rules of one card. Renders nothing at all when
 *  there is no detail and nothing is loading, so a caller can drop it in
 *  without guarding. */
export default function CardText({
  detail,
  loading,
  /** Shown when the lookup finished and found no card record. */
  missingNote = "Couldn't find this card in the database, so there's no text to show.",
}: {
  detail: CardDetail | null;
  loading: boolean;
  missingNote?: string;
}) {
  if (loading && !detail) return <p className="text-sm text-slate-400">Looking up the card…</p>;
  if (!detail) return <p className="text-sm text-slate-500">{missingNote}</p>;

  return (
    <div className="space-y-3">
      {detail.abilities.map((a) => (
        <div key={a.name}>
          <p className="text-sm font-semibold">
            <span className="mr-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">
              Ability
            </span>
            {a.name}
          </p>
          <p className="text-sm leading-relaxed text-slate-700">{a.text}</p>
        </div>
      ))}
      {detail.attacks.map((a, i) => (
        <div key={i}>
          <p className="flex items-baseline justify-between gap-2 text-sm font-semibold">
            <span>
              {a.cost.filter((c) => c.toLowerCase() !== "free").length > 0 && (
                <span className="mr-1 text-slate-400">
                  {"⚡".repeat(a.cost.filter((c) => c.toLowerCase() !== "free").length)}
                </span>
              )}
              {a.name}
            </span>
            <span className="shrink-0 text-slate-500">{a.damage || "—"}</span>
          </p>
          {a.text && <p className="text-sm leading-relaxed text-slate-700">{a.text}</p>}
        </div>
      ))}
      {detail.rules.map((r, i) => (
        <p key={i} className="text-sm leading-relaxed text-slate-700">
          {r}
        </p>
      ))}
      {(detail.weak || detail.resist || detail.retreat != null) && (
        <p className="text-xs text-slate-500">
          {[
            detail.weak ? `Weakness ${detail.weak.type} ${detail.weak.value}` : null,
            detail.resist ? `Resistance ${detail.resist.type} ${detail.resist.value}` : null,
            detail.retreat != null ? `Retreat ${detail.retreat}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {hasNoText(detail) && (
        // Says what was actually TRIED, which is the difference between
        // "nobody has looked yet" and "everything available has been looked
        // at". The old wording said it would fill in "the first time the
        // card is used in a battle", which was both a strange thing to ask
        // of somebody reading a card and, by then, out of date.
        <p className="text-sm text-slate-500">
          {detail.triedPicture
            ? "No printed text for this one. Basic Energy has none — for anything else, the card databases don't list it and reading it from the picture didn't work either. It's tried again when a clearer picture of the card arrives."
            : detail.image
              ? "No printed text on file yet. Basic Energy has none; anything else fills in the next time the card is looked up."
              : "No printed text on file, and no picture to read it from yet. It fills in once the card has a picture."}
        </p>
      )}
    </div>
  );
}
