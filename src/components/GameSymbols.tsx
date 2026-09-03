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

const ENERGY: Record<string, { bg: string; fg: string }> = {
  grass: { bg: "#78b21f", fg: "#ffffff" },
  fire: { bg: "#e04c39", fg: "#ffffff" },
  water: { bg: "#2e9be0", fg: "#ffffff" },
  lightning: { bg: "#f5c500", fg: "#5e4a00" },
  psychic: { bg: "#a65e9a", fg: "#ffffff" },
  fighting: { bg: "#c56f38", fg: "#ffffff" },
  darkness: { bg: "#2a4a5c", fg: "#ffffff" },
  metal: { bg: "#8a9aa4", fg: "#ffffff" },
  fairy: { bg: "#e06c9f", fg: "#ffffff" },
  dragon: { bg: "#b8862f", fg: "#ffffff" },
  colorless: { bg: "#d8d4cf", fg: "#4b463f" },
};

/** The glyph inside the disc — hand-drawn approximations of the shapes the
 *  cards print (a droplet, a flame, a leaf...), not letters. `fg` fills the
 *  glyph; `bg` cuts details back out of it (an eye's pupil, a leaf's vein).
 *  Inline SVG rather than image assets: nothing to load, crisp at text
 *  size, recolorable, and no third-party artwork to license. */
function energyGlyph(type: string, fg: string, bg: string): ReactNode {
  switch (type) {
    case "water":
      return <path fill={fg} d="M12 2.5C8.2 8 6 11.4 6 14.4a6 6 0 0 0 12 0c0-3-2.2-6.4-6-11.9z" />;
    case "fire":
      return (
        <path
          fill={fg}
          d="M12 2c3 4.2 6 6.3 6 11a6 6 0 0 1-12 0c0-2 .7-3.6 2-5.1-.2 1.9.6 2.9 1.7 3.2C9.2 8.2 10.2 5 12 2z"
        />
      );
    case "grass":
      return (
        <>
          <path fill={fg} d="M19.5 4C10 3.6 4.5 8.5 4.5 14.6c0 3.2 2.2 5.4 5.3 5.4 6.4 0 10.6-6.6 9.7-16z" />
          <path stroke={bg} strokeWidth="1.6" fill="none" d="M7.5 17.5C10.5 13.5 13.5 10.5 17 7.5" />
        </>
      );
    case "lightning":
      return <path fill={fg} d="M13.2 2 5 14h4.6l-1.4 8L17 10h-4.6l.8-8z" />;
    case "psychic":
      return (
        <>
          <path
            fill={fg}
            d="M12 5.8c-5 0-8.6 5.4-8.8 6.2.2.8 3.8 6.2 8.8 6.2s8.6-5.4 8.8-6.2c-.2-.8-3.8-6.2-8.8-6.2z"
          />
          <circle cx="12" cy="12" r="3.4" fill={bg} />
          <circle cx="12" cy="12" r="1.5" fill={fg} />
        </>
      );
    case "fighting":
      return (
        <>
          <path
            fill={fg}
            d="M5.5 12.5a6.5 6.5 0 0 1 13 0v3.2a4.3 4.3 0 0 1-4.3 4.3H9.8a4.3 4.3 0 0 1-4.3-4.3z"
          />
          <path stroke={bg} strokeWidth="1.4" fill="none" d="M10 7.5v6M14 7.5v6" />
        </>
      );
    case "darkness":
      return <path fill={fg} d="M14.5 3a9.5 9.5 0 1 0 6.2 15.9A10.5 10.5 0 0 1 14.5 3z" />;
    case "metal":
      return (
        <>
          <path fill={fg} d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z" />
          <circle cx="12" cy="12" r="3.2" fill={bg} />
        </>
      );
    case "fairy":
      return <path fill={fg} d="M12 2.6l2.3 7 7 2.4-7 2.4-2.3 7-2.3-7-7-2.4 7-2.4z" />;
    case "dragon":
      return <path fill={fg} d="M12 2.8 19 9l-7 12.2L5 9z" />;
    case "colorless":
      return (
        <path
          fill={fg}
          d="M12 2.8l2.5 6 6.4.5-4.9 4.2 1.5 6.3L12 16.4l-5.5 3.4 1.5-6.3-4.9-4.2 6.4-.5z"
        />
      );
    default:
      return null;
  }
}

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
      className="mx-px inline-flex h-[1.15em] w-[1.15em] shrink-0 items-center justify-center rounded-full align-[-0.18em] shadow-[inset_0_-1px_1px_rgba(0,0,0,0.2)]"
      style={{ background: look.bg }}
    >
      <svg viewBox="0 0 24 24" className="h-[0.85em] w-[0.85em]" aria-hidden="true">
        {energyGlyph(resolved, look.fg, look.bg)}
      </svg>
    </span>
  );
}
