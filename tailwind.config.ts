import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // The Phase 6 restyle happens HERE, not in ten thousand class edits.
        // Every screen is written in slate-* text and poke-* accents; mapping
        // those names onto the design system's values restyles the whole app
        // at once with zero behaviour churn. The names get cleaned up
        // opportunistically — the colours are already the new ones.
        poke: {
          red: "#D8452F", // destructive / damage — the system's negative
          dark: "#16171B", // ink
          gold: "#E8FF3A", // highlight
          blue: "#2C5CFF", // accent
        },
        slate: {
          50: "#F7F6F3", // panel-alt
          100: "#F2F0EC", // sunken
          200: "#E7E4DD", // line
          300: "#D8D4CB", // line-strong
          400: "#9A9A99", // ink5
          500: "#7C7C7B", // ink4
          600: "#5A5C63", // ink3
          700: "#3E4046", // ink2
          800: "#16171B",
          900: "#16171B", // ink
        },
        // TrainerDeck design tokens, from the handoff's token sheet. The
        // poke-* tokens above survive until the Phase 6 restyles retire them
        // screen by screen.
        brand: {
          ink: "#16171B",
          ink2: "#3E4046",
          ink3: "#5A5C63",
          ink4: "#7C7C7B",
          ink5: "#9A9A99",
          canvas: "#FBFAF8",
          sunken: "#F2F0EC",
          panel: "#FFFFFF",
          "panel-alt": "#F7F6F3",
          line: "#E7E4DD",
          "line-strong": "#D8D4CB",
          "line-soft": "#F2F0EC",
          accent: "#2C5CFF",
          /** Lighter accent for dark surfaces, where #2C5CFF is too dim. */
          "accent-soft": "#5E86FF",
          "accent-tint": "#F7F9FF",
          "accent-line": "#C9D6FF",
          highlight: "#E8FF3A",
          positive: "#1F7A43",
          warning: "#E0A21A",
          negative: "#D8452F",
        },
        // The dark surfaces (marketing footer, how-it-works band, owner
        // dashboard later).
        dark: {
          canvas: "#0F1013",
          panel: "#171A1F",
          "panel-alt": "#1D2027",
          tile: "#22242A",
          line: "#24262C",
          line2: "#2E3037",
          line3: "#31333A",
          ink: "#F4F3F1",
          ink2: "#D8D7D4",
          ink3: "#A9AAAF",
          ink4: "#8A8C93",
          ink5: "#7C7E85",
        },
      },
      fontFamily: {
        // Loaded via next/font in the root layout, which sets the variables.
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
