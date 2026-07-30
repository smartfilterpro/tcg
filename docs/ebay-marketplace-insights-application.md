# eBay Marketplace Insights API — access request

Draft text for the restricted-access request at developer.ebay.com. Paste and
adapt; the field names on eBay's form change, so match the answers to whatever
it asks rather than pasting wholesale.

Applications get declined for vagueness. Everything below is specific about
what data is used, what it is used for, and why active listings cannot do the
job — which is the actual question being asked.

---

## Application name

TrainerDeck — Pokémon TCG collection manager

## What does your application do?

TrainerDeck is a web application that helps Pokémon Trading Card Game players
manage a physical card collection. Users photograph their cards, the app
identifies each one and records it, and they can then build decks from what
they own, track collection value, and decide whether an individual card is
worth submitting to a professional grading service (PSA, BGS, CGC).

## How will you use the Marketplace Insights API?

For one purpose: telling a user whether professionally grading a specific card
they own is economically worthwhile.

Grading costs money per card and takes weeks. Whether it makes sense depends
entirely on the gap between what the raw card sells for and what the same card
sells for in a given graded tier. That is a question about completed sales,
and it is the single most valuable thing the app can tell someone about their
collection.

Concretely, per card the user asks about, we would query recent sold items and
derive:

- the raw (ungraded) sale price
- sale prices for the same card in graded tiers, where sales exist
- the number of sales behind each figure, so we can say plainly when the data
  is too thin to draw a conclusion from

The user sees a comparison of the grading fee against the realistic uplift.
Our recommendation is frequently "no, this is not worth grading" — the point
is an honest answer, not a nudge toward a transaction.

## Why can't the Browse API meet this need?

Browse returns active listings, which are asking prices. For collectible
single cards these run substantially above realised sale prices, and the gap
is not a constant we could correct for — it varies by card, by grade tier and
by how thin the market is for that specific card.

Presenting an asking price as a card's value would give users a materially
wrong answer to a question they are about to spend money on. We would rather
show nothing than show that, which is why we are applying.

We do use the Browse API, and will continue to, for a different and
appropriate purpose: when the app recommends cards a user should buy to
improve a deck, it shows current asking prices from active listings, clearly
labelled as asking prices. That is a buying context, where an ask is the
correct number.

## What data will you store, and for how long?

As little as possible, and not for long. Price results are held in an
in-process memory cache with a six-hour expiry and a bounded size. Nothing
from the eBay API is written to our database, and the cache does not survive a
process restart.

We store no eBay user data of any kind. The application uses the client
credentials flow only; no eBay user signs in to TrainerDeck, and we hold no
eBay user identifiers, listings, or account information.

## Expected call volume

Low. Grading decisions are made a card at a time, not in bulk, and results are
cached. We estimate well under 1,000 calls per day at launch, and calls scale
with the number of grading questions asked rather than with page views.

## Marketplace account deletion compliance

Implemented and verified. Our endpoint answers eBay's challenge and
acknowledges deletion notifications. We hold no eBay user data to erase, and
the endpoint is in place so that remains verifiable rather than asserted.

---

## Notes for us, not for eBay

- Every claim above is true of the code as it stands. The retention answer
  describes `TTL_MS` and the in-memory cache in `src/lib/ebayListings.ts`; the
  Browse usage describes the deck buy-list; the compliance answer describes
  `src/app/api/ebay/account-deletion/route.ts`. If any of that changes, this
  document has to change with it — an approval obtained on a description we
  have stopped honouring is worse than no approval.
- If the form asks for a demo or screenshots, the grading report page is the
  one to show: it already has the value comparison, currently fed by a
  third-party price source we would be supplementing.
