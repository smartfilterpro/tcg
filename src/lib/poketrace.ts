// PokeTrace price source (https://poketrace.com) — free-tier API with
// daily-updated TCGplayer/eBay/Cardmarket prices and graded values.
// Entirely optional: no POKETRACE_API_KEY env var → feature off.
import { numberKey } from "@/lib/pokemontcg";
import { setsAgree } from "@/lib/setName";
import { PublicError } from "@/lib/apiError";

const BASE = "https://api.poketrace.com/v1";

// Trimmed: a stray newline/space from copy-pasting the key into Railway
// would make every request's header invalid.
function apiKey(): string {
  return (process.env.POKETRACE_API_KEY ?? "").trim();
}

export function poketraceEnabled(): boolean {
  return apiKey().length > 0;
}

// Free plan burst limit is 1 request per 2 seconds — every call goes through
// a serial queue with spacing, or the very first parallel batch would 429.
const MIN_INTERVAL_MS = 2100;
let lastCallAt = 0;
let queueChain: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  };
  const p = queueChain.then(run, run);
  queueChain = p.catch(() => {});
  return p;
}

async function ptFetch(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { "X-API-Key": apiKey(), Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
}

async function ptGet(path: string): Promise<unknown | null> {
  return throttled(async () => {
    let res = await ptFetch(path);
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; retryAfter?: number };
      if (body.code === "BURST_RATE_LIMIT_EXCEEDED") {
        await new Promise((r) => setTimeout(r, ((body.retryAfter ?? 3) + 1) * 1000));
        res = await ptFetch(path);
      } else {
        // Daily cap reached — stop the whole run's PokeTrace usage.
        throw new PublicError("PokeTrace daily limit reached — resumes tomorrow");
      }
    }
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`PokeTrace ${res.status}`);
    }
    return res.json();
  });
}

interface PtCard {
  id?: string;
  name?: string;
  cardNumber?: string | null;
  set?: { slug?: string; name?: string } | null;
  productType?: string;
  prices?: Record<string, Record<string, { avg?: number | null } | undefined> | undefined>;
}

function setSlug(setName: string): string {
  return setName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Find a card's PokeTrace id: GET /v1/cards?search=<name>&set=<slug>&market=US,
 *  falling back to a name-only search if the set slug doesn't match theirs.
 *  Match quality is enforced on OUR side by collector-number comparison, so
 *  a loose search can never mis-price a card. Uses 1–2 requests. */
export async function searchPoketraceCard(
  name: string,
  number: string | null,
  setName: string | null
): Promise<{ id: string | null; requests: number }> {
  const clean = name.trim();
  if (!clean) return { id: null, requests: 0 };
  let requests = 0;
  let list: PtCard[] = [];

  const attempts: string[] = [];
  if (setName) {
    // Their set slugs are inconsistent between examples ("base-set" vs
    // "pokemon-base-set") — try both before falling back to name-only.
    const slug = setSlug(setName);
    attempts.push(`search=${encodeURIComponent(clean)}&set=${encodeURIComponent(slug)}&market=US&limit=20`);
    attempts.push(
      `search=${encodeURIComponent(clean)}&set=${encodeURIComponent(`pokemon-${slug}`)}&market=US&limit=20`
    );
  }
  attempts.push(`search=${encodeURIComponent(clean)}&market=US&limit=20`);

  for (const qs of attempts) {
    requests += 1;
    const json = (await ptGet(`/cards?${qs}`)) as { data?: PtCard[] } | null;
    if (Array.isArray(json?.data) && json.data.length > 0) {
      list = json.data;
      break;
    }
  }
  if (list.length === 0) return { id: null, requests };

  const wantedNumber = numberKey(number);
  const scored = list
    .filter((c) => c.id && (c.productType == null || c.productType === "single"))
    .map((c) => {
      let score = 0;
      // PokeTrace numbers look like "004/102" — compare digits-only keys.
      const theirNumber = numberKey((c.cardNumber ?? "").split("/")[0]);
      const numberOk = !!wantedNumber && theirNumber === wantedNumber;
      if (numberOk) score += 4;
      const setOk = setsAgree(c.set?.name ?? null, setName);
      if (setOk) score += 2;
      if ((c.name ?? "").toLowerCase() === clean.toLowerCase()) score += 1;
      return { c, score, numberOk, setOk };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  // A number match ALONE is not enough when we know the set.
  //
  // It was: four points, earned by the collector number and nothing else,
  // and the set was worth two decorative ones. But a promo bundle reprints
  // a card at its ORIGINAL number — the Trick or Trade Haunter is 103/162,
  // the same as the Temporal Forces Haunter — so name and number match
  // perfectly across two different cards. And the id this returns is
  // WRITTEN TO THE CARD and reused forever after, so a single wrong match
  // means every future price and grade for that card is quietly read off
  // somebody else's.
  //
  // So: the number and the set have to agree. Where we have no set name to
  // check against, the old rule stands — it is the best that can be done,
  // and refusing outright would leave those cards unpriced.
  const acceptable =
    best &&
    (setName
      ? (best.numberOk && best.setOk) || (!wantedNumber && best.setOk && best.score >= 3)
      : best.score >= 4);
  return { id: acceptable ? best.c.id ?? null : null, requests };
}

export interface PoketracePrices {
  /** Best raw (ungraded) USD market price: TCGplayer NM, else eBay NM. */
  market: number | null;
  /** Which source `market` came from, because they are not equally
   *  trustworthy and the caller has to know which it got.
   *
   *  TCGplayer's number is the market price of ONE single in that condition.
   *  eBay's is an average of completed sales, and a completed sale for a
   *  common is very often a bulk lot — "500 card lot", a full set, a sealed
   *  box — or a graded slab. Averaging those produces a number that is real,
   *  correctly computed, and nothing to do with what one loose card is
   *  worth. It is how a Shuppet ends up at $706. */
  marketSource: "tcgplayer" | "ebay" | null;
  /** Graded snapshot, e.g. { "PSA_10": 5200, "CGC_9": 800 }. */
  graded: Record<string, number> | null;
}

/** Current prices for a known PokeTrace card id (one request). */
export async function getPoketracePrices(id: string): Promise<PoketracePrices | null> {
  const json = (await ptGet(`/cards/${encodeURIComponent(id)}`)) as { data?: PtCard } | null;
  const card = json?.data;
  if (!card) return null;
  const tcg = card.prices?.tcgplayer ?? {};
  const ebay = card.prices?.ebay ?? {};
  // Ordered by how much a single loose card's price can be trusted from it:
  // TCGplayer near mint, TCGplayer lightly played, and only then eBay's
  // completed-sales average. eBay used to sit second, which meant any card
  // TCGplayer hadn't listed yet — every card in a set released last month —
  // took a lot price as its market value.
  const candidates: Array<[number | null | undefined, "tcgplayer" | "ebay"]> = [
    [tcg["NEAR_MINT"]?.avg, "tcgplayer"],
    [tcg["LIGHTLY_PLAYED"]?.avg, "tcgplayer"],
    [ebay["NEAR_MINT"]?.avg, "ebay"],
  ];
  const hit = candidates.find(([v]) => typeof v === "number" && v > 0);
  const market = hit?.[0] ?? null;
  const marketSource = hit?.[1] ?? null;

  const graded: Record<string, number> = {};
  for (const source of [ebay, tcg]) {
    for (const [tier, entry] of Object.entries(source)) {
      if (/^(PSA|BGS|CGC)_/i.test(tier) && typeof entry?.avg === "number" && !(tier in graded)) {
        graded[tier] = entry.avg;
      }
    }
  }
  return {
    market: typeof market === "number" && market > 0 ? market : null,
    marketSource: typeof market === "number" && market > 0 ? marketSource : null,
    graded: Object.keys(graded).length > 0 ? graded : null,
  };
}
