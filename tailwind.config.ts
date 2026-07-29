import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        poke: {
          red: "#EE1515",
          dark: "#222224",
          gold: "#FFCB05",
          blue: "#2A75BB",
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
