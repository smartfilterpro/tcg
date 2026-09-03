// The games' own iconography, inline.
//
// Magic text carries mana as {2}{U} tokens — Scryfall's oracle text prints
// them that way, and DeckAI quotes them faithfully — and Pokémon attack
// costs arrive as lists of energy-type names. Both were being shown as raw
// text, which reads like markup to exactly the person the app most wants to
// teach. These render them the way the cards themselves do: small colored
// symbols.
//
// Pure CSS circles rather than symbol fonts or images: nothing to load,
// nothing to license, legible at inline sizes, and the full name rides in
// the title/aria-label so nothing is lost to anybody.

import type { ReactNode } from "react";

/* ------------------------------------------------------------------- MTG */

/** Look of one mana chip: background, text color, and what to print. */
function manaLook(sym: string): { bg: string; fg: string; label: string; name: string } | null {
  const s = sym.toUpperCase();
  const COLORS: Record<string, { bg: string; fg: string; name: string }> = {
    W: { bg: "#f6f1d5", fg: "#6b5d1f", name: "white mana" },
    U: { bg: "#bcd7ea", fg: "#1d5673", name: "blue mana" },
    B: { bg: "#4a4441", fg: "#efeae6", name: "black mana" },
    R: { bg: "#eea88c", fg: "#7e2d18", name: "red mana" },
    G: { bg: "#a9c9a4", fg: "#1d5e2f", name: "green mana" },
    C: { bg: "#d5d1cc", fg: "#4b463f", name: "colorless mana" },
    S: { bg: "#dbe8ee", fg: "#38606f", name: "snow mana" },
  };
  if (COLORS[s]) return { ...COLORS[s], label: s === "S" ? "❄" : s };
  if (/^\d{1,2}$/.test(s) || s === "X" || s === "Y" || s === "Z") {
    return { bg: "#d5d1cc", fg: "#4b463f", label: s, name: `${s} generic mana` };
  }
  if (s === "T") return { bg: "#d5d1cc", fg: "#4b463f", label: "↷", name: "tap" };
  if (s === "Q") return { bg: "#d5d1cc", fg: "#4b463f", label: "↶", name: "untap" };
  if (s === "E") return { bg: "#d5d1cc", fg: "#4b463f", label: "⚡", name: "energy counter" };
  // Hybrid ({W/U}) and Phyrexian ({B/P}): one chip, both halves printed.
  // A split-circle render isn't worth the CSS; the letters say it.
  if (/^[0-9WUBRGC]\/[WUBRGCP]$/.test(s)) {
    const base = COLORS[s[0]] ?? { bg: "#d5d1cc", fg: "#4b463f", name: "mana" };
    return { ...base, label: s, name: `${s} mana` };
  }
  return null;
}

function ManaChip({ sym }: { sym: string }) {
  const look = manaLook(sym);
  if (!look) return <>{`{${sym}}`}</>;
  return (
    <span
      title={look.name}
      aria-label={look.name}
      className="mx-px inline-flex h-[1.1em] min-w-[1.1em] shrink-0 items-center justify-center rounded-full px-[0.1em] align-[-0.15em] text-[0.72em] font-bold leading-none shadow-[inset_0_-1px_1px_rgba(0,0,0,0.18)]"
      style={{ background: look.bg, color: look.fg }}
    >
      {look.label}
    </span>
  );
}

/** The two games' inline cost notations, one pass:
 *  - Magic braces: {2}{U}, {T}, {W/P} — Scryfall's oracle convention.
 *  - Pokémon brackets: [C][C], [W][D], [Grass] — the community (and our
 *    card reads) write attack costs this way.
 *  Anything else in braces or brackets stays literal text, so a stray
 *  {like this} or [footnote] can never half-render. Pokémon letters are
 *  matched uppercase-only — the convention writes them that way, and it
 *  keeps prose like "[a]" out of the symbol path. */
const COST_TOKEN =
  /\{(\d{1,2}|[WUBRGCSXYZTQE]|[0-9WUBRGC]\/[WUBRGCP])\}|\[(G|R|W|L|P|F|D|M|Y|N|C|Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\]/g;

/** A line of text with its {mana} and [energy] tokens rendered as the
 *  symbols the cards themselves print. */
export function withManaSymbols(text: string, key: string): ReactNode[] {
  if (!text.includes("{") && !text.includes("[")) return [text];
  const out: ReactNode[] = [];
  const re = new RegExp(COST_TOKEN.source, "g");
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(<ManaChip key={`${key}-m${n++}`} sym={m[1]} />);
    else out.push(<EnergyIcon key={`${key}-m${n++}`} type={m[2]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* --------------------------------------------------------------- Pokémon */

const ENERGY: Record<string, { bg: string; fg: string; letter: string }> = {
  grass: { bg: "#78b21f", fg: "#ffffff", letter: "G" },
  fire: { bg: "#e04c39", fg: "#ffffff", letter: "R" },
  water: { bg: "#2e9be0", fg: "#ffffff", letter: "W" },
  lightning: { bg: "#f5c500", fg: "#5e4a00", letter: "L" },
  psychic: { bg: "#a65e9a", fg: "#ffffff", letter: "P" },
  fighting: { bg: "#c56f38", fg: "#ffffff", letter: "F" },
  darkness: { bg: "#2a4a5c", fg: "#ffffff", letter: "D" },
  metal: { bg: "#8a9aa4", fg: "#ffffff", letter: "M" },
  fairy: { bg: "#e06c9f", fg: "#ffffff", letter: "Y" },
  dragon: { bg: "#b8862f", fg: "#ffffff", letter: "N" },
  colorless: { bg: "#d8d4cf", fg: "#4b463f", letter: "C" },
};

/** The bracket convention's single letters → type names. R is Fire and W
 *  is Water by long-standing community convention, not initials. */
const ENERGY_LETTERS: Record<string, string> = {
  g: "grass",
  r: "fire",
  w: "water",
  l: "lightning",
  p: "psychic",
  f: "fighting",
  d: "darkness",
  m: "metal",
  y: "fairy",
  n: "dragon",
  c: "colorless",
};

/** One energy symbol, by type name ("Grass", "colorless") or bracket letter
 *  ("C", "W"). Unknown types fall back to the word itself, so new energy
 *  never renders as nothing. */
export function EnergyIcon({ type }: { type: string }) {
  const raw = type.trim().toLowerCase();
  const resolved = raw.length === 1 ? (ENERGY_LETTERS[raw] ?? raw) : raw;
  const look = ENERGY[resolved];
  if (!look) return <>{type}</>;
  const fullName = resolved.charAt(0).toUpperCase() + resolved.slice(1);
  return (
    <span
      title={`${fullName} Energy`}
      aria-label={`${fullName} Energy`}
      className="mx-px inline-flex h-[1.1em] w-[1.1em] shrink-0 items-center justify-center rounded-full align-[-0.15em] text-[0.68em] font-bold leading-none shadow-[inset_0_-1px_1px_rgba(0,0,0,0.18)]"
      style={{ background: look.bg, color: look.fg }}
    >
      {look.letter}
    </span>
  );
}
