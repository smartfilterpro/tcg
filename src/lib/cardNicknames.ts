// What players call cards vs what's printed on them.
//
// "Bubble Mew" appears on no card anywhere — it's what the community calls
// the Mew ex Special Illustration Rare from Paldean Fates — so a catalogue
// search for it comes back empty and the chat looks like it doesn't know a
// famous card. The model usually DOES know these from training; the fix
// there is prompt permission (see assistantScope). This table is the
// belt-and-braces layer under it: when the search tool is handed a known
// nickname verbatim, it searches for the real card and says which mapping
// it used, so even a literal pass-through lands on the right rows.
//
// Deliberately short and only entries whose meaning is settled community
// canon — a wrong mapping stated confidently is worse than an empty result.
// Nicknames coined after the model's training data land here too, which is
// the main reason the file exists rather than the prompt alone.

interface Nickname {
  /** Ways players write it, lowercase. Matched against the WHOLE query
   *  (normalised), never a substring — "bob" must not fire inside a search
   *  for "Bobbing Wailord". */
  aliases: string[];
  /** The printed card name to search instead. */
  name: string;
  /** Narrows the search when the nickname means one printing. */
  set?: string;
  /** Shown to the model so it can point at the exact row. */
  number?: string;
}

const NICKNAMES: Nickname[] = [
  // ------------------------------------------------------------- Pokémon
  {
    aliases: ["moonbreon"],
    name: "Umbreon VMAX",
    set: "Evolving Skies",
    number: "215",
  },
  {
    aliases: ["bubble mew"],
    name: "Mew ex",
    set: "Paldean Fates",
    number: "232",
  },
  {
    aliases: ["van gogh pikachu", "van gogh pika"],
    name: "Pikachu with Grey Felt Hat",
  },
  {
    aliases: ["rainbow charizard", "rainbow zard"],
    name: "Charizard VMAX",
    set: "Champion's Path",
    number: "74",
  },
  // ------------------------------------------------------------- Magic
  { aliases: ["bob"], name: "Dark Confidant" },
  { aliases: ["goyf"], name: "Tarmogoyf" },
  { aliases: ["bolt"], name: "Lightning Bolt" },
  { aliases: ["snappy", "snapcaster"], name: "Snapcaster Mage" },
  { aliases: ["gary"], name: "Gray Merchant of Asphodel" },
  { aliases: ["sad robot"], name: "Solemn Simulacrum" },
  { aliases: ["tim"], name: "Prodigal Sorcerer" },
  { aliases: ["mom"], name: "Mother of Runes" },
  { aliases: ["steve"], name: "Sakura-Tribe Elder" },
  { aliases: ["fow"], name: "Force of Will" },
  { aliases: ["jtms"], name: "Jace, the Mind Sculptor" },
  { aliases: ["bop"], name: "Birds of Paradise" },
  { aliases: ["stp"], name: "Swords to Plowshares" },
];

function normalise(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The card a community nickname means, or null when the query isn't one. */
export function resolveNickname(query: string): Nickname | null {
  const q = normalise(query);
  if (!q) return null;
  return NICKNAMES.find((n) => n.aliases.includes(q)) ?? null;
}
