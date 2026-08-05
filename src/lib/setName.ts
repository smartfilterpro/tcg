// Deciding whether two set names are the same set.
//
// Three databases name the same product three ways. pokemontcg.io says
// "Paldea Evolved", TCGplayer says "SV: Paldea Evolved", TCGdex drops the
// year off a promo bundle. Nothing joins them but the words, so every place
// that asks "is this the same card?" has to ask "is this the same set?"
// first, and has to ask it loosely.
//
// It also has to ask it AT ALL. This started life inside the duplicate merge,
// which for months matched cards on name and collector number alone — and a
// Trick or Trade bundle's reprints keep the ORIGINAL card's number, so its
// Haunter (103/162) looked identical to the Temporal Forces Haunter it
// reprints. One got deleted. Name plus number is not a card's identity; it is
// only an identity WITHIN a set.
//
// Both callers fail SAFE in the same direction: the import refuses to merge
// (leaving a duplicate row, which is fixable by hand) and the search refuses
// to fold (showing a card twice, which is visible). Neither loses a card. So
// when the names are ambiguous, this says no.

/** Letters and digits only, so punctuation and spacing can't disagree. */
export function setKey(n: string | null | undefined): string {
  return (n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(n: string | null | undefined): string[] {
  return (n ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const YEAR = /^(19|20)\d{2}$/;

/** A word that one source adds and another leaves out, which therefore says
 *  nothing about WHICH set this is.
 *
 *  Two kinds qualify. A year, because a bundle is "Trick or Trade BOOster
 *  Bundle 2024" at TCGplayer and often just "Trick or Trade BOOster Bundle"
 *  elsewhere. And a short code — "SV", "SWSH", "XY" — because those are era
 *  prefixes stapled on by one catalogue's naming convention.
 *
 *  Everything else counts as distinguishing, deliberately. "Base Set" and
 *  "Base Set 2" are different sets that share card names AND collector
 *  numbers, which is exactly the shape of the mistake that deleted a Haunter;
 *  a bare "2" must never read as decoration. Nor must a real word: "Sword &
 *  Shield" is not "Sword & Shield—Battle Styles". */
function isDecoration(t: string): boolean {
  if (YEAR.test(t)) return true;
  // An era or product code: letters, then optionally a number. "SV",
  // "SWSH", "XY", "HGSS", and the numbered ones both paid catalogues use —
  // "SWSH05: Battle Styles" against our "Battle Styles", "MEO3: Perfect
  // Order" against "Perfect Order", "SM12", "ME01".
  //
  // This was capped at four characters, which fitted "MEO3" and shut out
  // "SWSH05" — and a sync then declared thousands of cards to be in a
  // different set from themselves, refusing to price them. The shape is
  // what identifies a code, not its length: up to four letters, up to three
  // digits, nothing else.
  //
  // Letters are REQUIRED, so a bare "2" is not decoration — and a bare 2 is
  // the whole difference between Base Set and Base Set 2. Digits are
  // optional but capped, so a real word ("Promos", "Battle") never
  // qualifies.
  return /^[a-z]{1,4}\d{0,3}$/.test(t);
}

/** Loose agreement: the same set, allowing for how differently it is named.
 *
 *  Equal after punctuation is stripped, or one name's words are all present
 *  in the other's and everything left over is decoration.
 *
 *  A missing name on either side is NOT agreement. Callers use this to decide
 *  whether one row may stand in for another, and standing in for a card you
 *  cannot place is how a card disappears. */
export function setsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = setKey(a);
  const y = setKey(b);
  if (!x || !y) return false;
  if (x === y) return true;

  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return false;

  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const have = new Set(longer);
  if (!shorter.every((t) => have.has(t))) return false;

  const inShorter = new Set(shorter);
  return longer.filter((t) => !inShorter.has(t)).every(isDecoration);
}
