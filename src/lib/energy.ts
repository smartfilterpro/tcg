// Energy: what a card provides, and whether an attack can be paid for.
//
// The engine counted energy cards and compared the number to the length of
// the attack's cost. So two Water paid for ⚡⚡, and the bot would happily
// swing a Fire attack off a Psychic energy. Counting is the right answer to
// the wrong question — cost is a multiset of SYMBOLS, and paying it is a
// matching problem, not a subtraction.
//
// Matched exactly rather than greedily. The sizes are tiny (a cost is at
// most five symbols, a Pokémon rarely holds more than four energy) and a
// greedy pass gets it wrong in the case that actually comes up: spend the
// wildcard on the Colorless, then find nothing left for the Fire. Exhaustive
// search costs microseconds and is simply correct.

/** The eleven symbols the game uses. Colorless is the wildcard COST — any
 *  energy pays it — which is the opposite of a wildcard SOURCE. */
export const ENERGY_TYPES = [
  "Grass",
  "Fire",
  "Water",
  "Lightning",
  "Psychic",
  "Fighting",
  "Darkness",
  "Metal",
  "Dragon",
  "Fairy",
  "Colorless",
] as const;

export type EnergyType = (typeof ENERGY_TYPES)[number];

/** A source that pays for anything, one symbol's worth.
 *
 *  The honest answer for a Special Energy nobody has compiled yet. Refusing
 *  it would be worse than allowing it: the engine only warns, the player is
 *  holding the card and can read it, and a wrong refusal teaches people to
 *  ignore the warnings. */
export const ANY: "*" = "*";

const BY_LOWER = new Map(ENERGY_TYPES.map((t) => [t.toLowerCase(), t as EnergyType]));

/** Normalise whatever a card database called it. */
export function energyType(raw: string | null | undefined): EnergyType | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return null;
  if (BY_LOWER.has(key)) return BY_LOWER.get(key)!;
  // "Lightning" is "Electric" in some sources, "Darkness" is "Dark".
  if (key === "electric") return "Lightning";
  if (key === "dark") return "Darkness";
  if (key === "steel") return "Metal";
  if (key === "colourless" || key === "normal") return "Colorless";
  return null;
}

/** What one attached energy card can pay for.
 *
 *  `types` from the card database first, because it is stated rather than
 *  inferred. Basic energy usually arrives with none — the databases treat
 *  "Fire Energy" as an Energy card with no types — so the name is the
 *  fallback, and a Special Energy nobody has read yet becomes a wildcard
 *  rather than a refusal.
 *
 *  `provides` (from a compiled card) wins over both: it is the only thing
 *  that can say a Double Turbo pays for two Colorless. */
export function energyProvides(card: {
  name?: string;
  types?: string[] | null;
  provides?: string[] | null;
}): Array<EnergyType | typeof ANY> {
  if (card.provides?.length) {
    return card.provides.map((p) => (p === ANY ? ANY : (energyType(p) ?? ANY)));
  }
  const stated = (card.types ?? []).map(energyType).filter(Boolean) as EnergyType[];
  if (stated.length > 0) return stated;
  // "Basic Fire Energy", "Fire Energy" — the type is in the name, and only
  // for BASIC energy. A Special Energy's name says nothing reliable about
  // what it provides, so anything unrecognised stays a wildcard.
  const name = (card.name ?? "").toLowerCase();
  for (const t of ENERGY_TYPES) {
    if (t !== "Colorless" && name.includes(t.toLowerCase())) return [t as EnergyType];
  }
  if (name.includes("electric")) return ["Lightning"];
  if (name.includes("dark ") || name.startsWith("dark")) return ["Darkness"];
  return [ANY];
}

/** Strip the no-cost markers a database might use for a free attack. */
export function realCost(cost: string[] | null | undefined): EnergyType[] {
  return (cost ?? [])
    .filter((c) => {
      const k = c.trim().toLowerCase();
      return k && k !== "free" && k !== "none" && k !== "0";
    })
    .map((c) => energyType(c) ?? "Colorless");
}

export interface Payment {
  /** Can this cost be paid from these sources? */
  ok: boolean;
  /** The cost, normalised — for the message when it can't. */
  need: EnergyType[];
  /** What's attached, flattened to symbols. */
  have: Array<EnergyType | typeof ANY>;
  /** Which specific symbols are short. Empty when the shortfall is only in
   *  the total rather than in a colour. */
  missing: EnergyType[];
}

/** Exhaustive matching of a cost against a pool.
 *
 *  Colorless in a COST is satisfied by any source, so it is matched last —
 *  after the specific symbols have taken what only they can use. Within the
 *  specific symbols, backtracking handles the case a greedy pass fails:
 *  a wildcard source that could pay either of two colours must be assigned
 *  to whichever one has no alternative. */
export function payCost(
  cost: string[] | null | undefined,
  attached: Array<{ name?: string; cat?: string | null; types?: string[] | null; provides?: string[] | null }>
): Payment {
  const need = realCost(cost);
  const have: Array<EnergyType | typeof ANY> = [];
  for (const card of attached) {
    if (card.cat !== "energy") continue;
    have.push(...energyProvides(card));
  }

  const specific = need.filter((n) => n !== "Colorless");
  const colorless = need.length - specific.length;

  // Try to satisfy every specific symbol; `used` marks spent sources.
  const used = new Array(have.length).fill(false);
  const missing: EnergyType[] = [];

  const assign = (i: number): boolean => {
    if (i >= specific.length) return true;
    const want = specific[i];
    // Exact matches before wildcards: a wildcard spent here might be the
    // only thing that can pay a later symbol.
    const order = have
      .map((h, idx) => ({ h, idx }))
      .filter(({ h, idx }) => !used[idx] && (h === want || h === ANY))
      .sort((a, b) => (a.h === want ? -1 : 1) - (b.h === want ? -1 : 1));
    for (const { idx } of order) {
      used[idx] = true;
      if (assign(i + 1)) return true;
      used[idx] = false;
    }
    return false;
  };

  const specificOk = assign(0);
  if (!specificOk) {
    // Report the colours that couldn't be covered at all, which is the
    // useful half of "you can't pay for this".
    for (const want of specific) {
      if (!have.some((h) => h === want || h === ANY)) missing.push(want);
    }
  }
  const spare = used.filter((u) => !u).length;
  return {
    ok: specificOk && spare >= colorless,
    need,
    have,
    missing: [...new Set(missing)],
  };
}

/** "⚡⚡ — 2 Water attached" style, for a log line a player can act on. */
export function paymentNote(p: Payment): string {
  if (p.ok) return "";
  const need = p.need.length === 0 ? "no energy" : p.need.join(" + ");
  const have = p.have.length === 0 ? "nothing attached" : p.have.map((h) => (h === ANY ? "any" : h)).join(" + ");
  return `needs ${need}, has ${have}`;
}
