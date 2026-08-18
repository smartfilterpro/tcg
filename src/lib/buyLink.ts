// Where "buy this card" points, and who gets credit for the sale.
//
// TCGplayer's developer API is closed to new applicants, but earning from
// referred sales doesn't need it: their affiliate program (via Impact)
// hands out tracking links that wrap ordinary tcgplayer.com URLs. So this
// module builds the plain destination — the exact product page when the
// price sync gave us the card's tcgplayer_id, a search otherwise — and
// wraps it with the affiliate template when one is configured.
//
// TCGPLAYER_AFFILIATE_URL is the Impact tracking prefix ending just before
// the destination, e.g. "https://tcgplayer.pxf.io/c/NNNN/NNNN/NNNN?u=".
// It lives in the environment (Railway), never in the repo, same as every
// other credential — and until it is set, every link is a plain
// tcgplayer.com URL, so the buttons ship before the program approval does.
//
// Compliance lives with the links: anywhere these render, the UI shows a
// disclosure line when the wrapper is active (affiliateActive / the
// client-side isAffiliateLink test), because a tracked link a reader can't
// recognise as one is an FTC problem and an Impact terms problem at once.

const PRODUCT_BASE = "https://www.tcgplayer.com/product/";
const SEARCH_BASE = "https://www.tcgplayer.com/search/pokemon/product?q=";

function template(): string | null {
  const t = (process.env.TCGPLAYER_AFFILIATE_URL ?? "").trim();
  return t.startsWith("https://") ? t : null;
}

/** Whether links built right now carry the affiliate wrapper. */
export function affiliateActive(): boolean {
  return template() != null;
}

/** The plain tcgplayer.com destination for a card. */
export function tcgplayerUrl(card: {
  tcgplayerId?: number | string | null;
  name: string;
}): string {
  const id = card.tcgplayerId;
  if (id != null && String(id).trim() !== "") {
    return `${PRODUCT_BASE}${encodeURIComponent(String(id).trim())}`;
  }
  return `${SEARCH_BASE}${encodeURIComponent(card.name)}`;
}

/** The URL to put on a Buy button: affiliate-wrapped when configured. */
export function buyLinkFor(card: {
  tcgplayerId?: number | string | null;
  name: string;
}): string {
  const url = tcgplayerUrl(card);
  const t = template();
  return t ? `${t}${encodeURIComponent(url)}` : url;
}
