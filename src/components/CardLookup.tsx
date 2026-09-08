"use client";

// Look a card up WITHOUT owning it.
//
// Every road to a card's details used to run through the collection — to
// learn what something does or is worth, you first had to add it. This is
// the reference-desk path: the same search picker the add flow uses, but
// picking a card opens a read-only sheet — art with zoom, set, number,
// prices per finish, the printed text, a buy link, and the quick-ask
// chips into DeckAI — and writes nothing anywhere.

import { useState } from "react";
import CardPickerModal from "@/components/CardPickerModal";
import CardZoom from "@/components/CardZoom";
import CardText, { useCardText } from "@/components/CardText";
import { askDeckAI } from "@/components/TrainerChat";
import { artSrc } from "@/lib/art";
import { buyLinkFor } from "@/lib/buyLink";
import { variantLabel, cardGame } from "@/lib/types";
import type { CardSummary } from "@/lib/types";

export default function CardLookup({ game }: { game: "pokemon" | "mtg" }) {
  const [picking, setPicking] = useState(false);
  const [card, setCard] = useState<CardSummary | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const { detail, loading, retry } = useCardText(card?.id);

  const art = card ? artSrc(card.id, card.imageLarge ?? card.imageSmall, "large") : null;
  const finishPrices = card
    ? Object.entries(card.prices ?? {}).filter((e): e is [string, number] => e[1] != null)
    : [];
  const who = card ? `${card.name} (${card.setName} #${card.number})` : "";

  return (
    <>
      <button className="btn-secondary" onClick={() => setPicking(true)}>
        🔎 Look up
      </button>

      {picking && (
        <CardPickerModal
          initialQuery=""
          candidates={[]}
          game={game}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setCard(c);
            setPicking(false);
          }}
        />
      )}

      {card && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60 p-4"
          onClick={() => setCard(null)}
        >
          <div
            className="card-panel relative mx-auto my-6 w-full max-w-[min(46rem,94vw)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
              onClick={() => setCard(null)}
            >
              ✕
            </button>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:pr-6">
              {art ? (
                <button
                  type="button"
                  className="flex aspect-[63/88] w-40 shrink-0 cursor-zoom-in items-center justify-center self-center overflow-hidden rounded-lg bg-slate-100 shadow sm:self-start"
                  onClick={() => setZoom(art)}
                  aria-label={`See ${card.name} larger`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={art} alt={card.name} className="h-full w-full object-contain" />
                </button>
              ) : (
                <div className="flex aspect-[63/88] w-40 items-center justify-center self-center rounded-lg bg-slate-100 text-xs text-slate-400 sm:self-start">
                  📷 No art yet
                </div>
              )}
              <div className="w-full min-w-0 sm:flex-1">
                <h2 className="text-lg font-bold">{card.name}</h2>
                <dl className="mt-2 space-y-1 text-sm text-slate-600">
                  <div>
                    Set: <span className="font-medium">{card.setName}</span>
                  </div>
                  <div>
                    Number: #{card.number}
                    {card.setPrintedTotal ? `/${card.setPrintedTotal}` : ""}
                  </div>
                  {card.rarity && <div>Rarity: {card.rarity}</div>}
                  {card.supertype && <div>Card type: {card.supertype}</div>}
                  {(card.types ?? []).length > 0 && <div>Type: {(card.types ?? []).join(", ")}</div>}
                  {card.hp && <div>HP: {card.hp}</div>}
                  {card.marketPrice != null && (
                    <div>
                      Market price:{" "}
                      <span className="font-semibold text-green-700">
                        ${card.marketPrice.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {finishPrices.length > 1 && (
                    <div className="flex flex-wrap gap-1">
                      {finishPrices.map(([v, p]) => (
                        <span key={v} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">
                          {variantLabel(v)} ${p.toFixed(2)}
                        </span>
                      ))}
                    </div>
                  )}
                </dl>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <button
                    className="rounded-full border border-brand-line px-2.5 py-1 text-xs hover:bg-slate-50"
                    onClick={() => {
                      askDeckAI(`How does ${who} work in play? Explain what it does and when it's good.`);
                      setCard(null);
                    }}
                  >
                    🤖 How do I play this?
                  </button>
                  <button
                    className="rounded-full border border-brand-line px-2.5 py-1 text-xs hover:bg-slate-50"
                    onClick={() => {
                      askDeckAI(`Would ${who} fit any of my decks? Which ones, and what would it replace?`);
                      setCard(null);
                    }}
                  >
                    🤖 Would it fit my decks?
                  </button>
                  <a
                    className="rounded-full border border-brand-line px-2.5 py-1 text-xs hover:bg-slate-50"
                    href={buyLinkFor({ tcgplayerId: card.tcgplayerId, name: card.name, game: cardGame(card) })}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    🛒 Shop
                  </a>
                </div>
                <div className="mt-4 border-t border-brand-line pt-3">
                  <CardText detail={detail} loading={loading} onRetry={retry} />
                </div>
                <p className="mt-3 text-[11px] text-slate-400">
                  Just looking — nothing was added. Use “+ Add by search” or Scan to put it in
                  your collection.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {zoom && card && <CardZoom src={zoom} alt={card.name} onClose={() => setZoom(null)} />}
    </>
  );
}
