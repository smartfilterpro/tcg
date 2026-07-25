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
      },
    },
  },
  plugins: [],
};

export default config;
