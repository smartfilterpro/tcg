// The TrainerDeck mark — "the Fan" (option 1b from the logo sheet).
//
// Three cards splayed from a shared bottom pivot: many cards, one photo, which
// is the thing the app actually does differently. Built from the same 63:88
// card rectangle as the grids throughout the app, drawn in a 64×64 box.
//
// Deliberately NOT a Poké Ball. The old mark and the PokéDeck name are both
// Nintendo/The Pokémon Company trademarks — fine for a personal project, a
// real risk the moment the app charges anyone.

/** Brand colours are literals, not theme tokens: a logo has to render the same
 *  on a marketing page, an email, a favicon and a print sheet, none of which
 *  can read Tailwind config. */
const INK = "#16171B";
const INK_REVERSED = "#FBFAF8";
/** The second back card is one step lighter, which is what holds the three
 *  planes apart without any background-matching gaps. */
const BACK_2 = "#585B63";
const BACK_2_REVERSED = "#A9AAAF";
const ACCENT = "#2C5CFF";

/** Shared by both back cards. The y carries a +2.5 unit shift so the painted
 *  ink is optically centred in the box — the splayed tops make the raw
 *  geometry sit high, and without it the mark reads misaligned in a square
 *  tile and against the wordmark.
 *
 *  Verified by rasterising this component at 16/24/32/34/40/132px: left and
 *  right insets are equal and top equals bottom at every one. (The handoff
 *  quotes a 10.3px inset at 132px; that is the unrounded corner of the
 *  rotated rect. The painted ink sits at 12px because rx:3.5 cuts that
 *  corner off — the symmetry, which is what the shift is for, is exact.) */
const BACK_CARD = { x: 20.5, y: 11.5, width: 23, height: 37, rx: 3.5 } as const;
const FRONT_CARD = { x: 21.5, y: 17.5, width: 21, height: 32, rx: 3.5 } as const;
/** Both back cards pivot about the same point, low and centred, so they open
 *  like a held hand rather than rotating about their own middles. */
const PIVOT = "32 49.5";

export interface MarkProps {
  /** Rendered size in px. The viewBox scales, so any value works. */
  size?: number | string;
  className?: string;
  /** For dark surfaces: lightens the two back cards. The front card keeps the
   *  accent, which has enough contrast either way. */
  reversed?: boolean;
  /** Decorative beside a wordmark; give it a label when it stands alone. */
  title?: string;
}

/** The full-colour mark. Use this everywhere there's more than one ink. */
export function FanMark({ size = 24, className, reversed = false, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <rect
        {...BACK_CARD}
        fill={reversed ? INK_REVERSED : INK}
        transform={`rotate(-26 ${PIVOT})`}
      />
      <rect
        {...BACK_CARD}
        fill={reversed ? BACK_2_REVERSED : BACK_2}
        transform={`rotate(26 ${PIVOT})`}
      />
      <rect {...FRONT_CARD} fill={ACCENT} />
    </svg>
  );
}

/** Every id in a document must be unique, and this mark can appear several
 *  times on one page (nav, footer, an icon sheet). */
let maskSeq = 0;

/** The single-ink mark.
 *
 *  Separate artwork rather than a recolour, because the colour version holds
 *  its three planes apart by TONE — give it one ink and they merge into a
 *  blob. Here the separations are cut as transparent hairline gaps through a
 *  mask instead. Fills with `currentColor`, so it inherits text colour: use it
 *  for single-colour print, Safari's mask-icon, and anywhere it sits inside a
 *  coloured button. */
export function FanMarkOneInk({ size = 24, className, title }: Omit<MarkProps, "reversed">) {
  const id = `fan-oneink-${++maskSeq}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          {/* White keeps, black cuts. The two strokes trace the outlines of the
              shapes in front, so each card is separated from the one behind by
              a gap of nothing rather than by a different colour. */}
          <rect x="0" y="0" width="64" height="64" fill="#fff" />
          <rect
            {...BACK_CARD}
            fill="none"
            stroke="#000"
            strokeWidth={2.5}
            strokeLinejoin="round"
            transform={`rotate(26 ${PIVOT})`}
          />
          <rect
            {...FRONT_CARD}
            fill="none"
            stroke="#000"
            strokeWidth={3}
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <g mask={`url(#${id})`} fill="currentColor">
        <rect {...BACK_CARD} transform={`rotate(-26 ${PIVOT})`} />
        <rect {...BACK_CARD} transform={`rotate(26 ${PIVOT})`} />
        <rect {...FRONT_CARD} />
      </g>
    </svg>
  );
}

/** The mark on its own dark rounded tile.
 *
 *  For the favicon and app icon. The handoff says the planes compress at 16px;
 *  rasterising the one-ink mark and counting separate ink runs across its
 *  waist puts the floor higher than that — 3 runs at 32px and 132px, but a
 *  single merged run at 24px and 16px. So the tile is the right answer below
 *  32px, not just at 16px, and Safari's mask-icon (16px) must never get the
 *  bare one-ink mark. */
export function FanMarkTile({
  size = 32,
  className,
  title,
}: Omit<MarkProps, "reversed">) {
  const px = typeof size === "number" ? size : 32;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center bg-brand-ink ${className ?? ""}`}
      style={{ width: px, height: px, borderRadius: Math.round(px * 0.22) }}
    >
      {/* ~2/3 of the tile: enough padding that the mark reads as a badge. */}
      <FanMark size={Math.round(px * 0.66)} reversed title={title} />
    </span>
  );
}

export interface WordmarkProps {
  className?: string;
  /** Lighter accent on dark surfaces — #2C5CFF hasn't enough contrast there. */
  reversed?: boolean;
}

/** Trainer + Deck, the second half in the accent colour. */
export function Wordmark({ className, reversed = false }: WordmarkProps) {
  return (
    <span className={`font-display font-bold tracking-tight ${className ?? ""}`}>
      Trainer<span className={reversed ? "text-brand-accent-soft" : "text-brand-accent"}>Deck</span>
    </span>
  );
}

export interface LogoProps {
  /** "horizontal" for nav bars, "stacked" for splash and auth screens. */
  layout?: "horizontal" | "stacked";
  size?: number;
  reversed?: boolean;
  className?: string;
  /** Mark only — for tight spots like a collapsed mobile nav. */
  markOnly?: boolean;
}

/** Mark + wordmark, in the two lockups the sheet specifies. */
export function Logo({
  layout = "horizontal",
  size = 24,
  reversed = false,
  className,
  markOnly = false,
}: LogoProps) {
  if (markOnly) {
    return <FanMark size={size} reversed={reversed} className={className} title="TrainerDeck" />;
  }
  const stacked = layout === "stacked";
  return (
    <span
      className={`inline-flex ${stacked ? "flex-col items-center gap-2" : "flex-row items-center gap-[0.46em]"} ${className ?? ""}`}
    >
      <FanMark size={size} reversed={reversed} />
      <span
        // The wordmark scales with the mark rather than being fixed: the sheet
        // pairs a 34px mark with 25px type and a 24px mark with 16px type —
        // about 0.7× in both lockups.
        style={{ fontSize: Math.round(size * (stacked ? 0.38 : 0.7) * 10) / 10 }}
      >
        <Wordmark
          reversed={reversed}
          className={reversed ? "text-brand-canvas" : "text-brand-ink"}
        />
      </span>
    </span>
  );
}
