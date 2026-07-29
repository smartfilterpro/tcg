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
        // TrainerDeck rebrand tokens. Only the ones the mark and wordmark
        // need are here — the rest of the palette lands with the screens that
        // use it, rather than sitting unused. The poke-* tokens stay until
        // the rename ships; a half-renamed app looks broken.
        brand: {
          ink: "#16171B",
          canvas: "#FBFAF8",
          accent: "#2C5CFF",
          /** Lighter accent for dark surfaces, where #2C5CFF is too dim. */
          "accent-soft": "#5E86FF",
        },
      },
      fontFamily: {
        // Space Grotesk is the display face for headings and the wordmark.
        // Loaded via next/font in the layout, which sets the CSS variable.
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
