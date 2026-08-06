import type { MetadataRoute } from "next";
import { APP_NAME } from "@/lib/branding";

// What makes TrainerDeck installable.
//
// Served at /manifest.webmanifest by Next's metadata route, and linked from
// the root layout. Everything here is what a phone reads when somebody adds
// the app to their home screen: what to call it, what to draw, what colour to
// paint the window before the first pixel of the app arrives.
//
// ICONS ARE THE SVG. The mark is vector, and Chrome accepts an SVG with
// sizes:"any" for installability — so there is no build step, no generated
// PNG set to keep in sync with the logo, and the icon is sharp at every size
// a launcher asks for. iOS ignores this list entirely and uses the
// apple-icon.png already in app/, which is why that file stays.
//
// The maskable entry is a separate declaration on purpose: Android crops a
// maskable icon to whatever shape the launcher uses, and the mark's glyph
// sits inside the middle two thirds of its tile, so a circular crop takes
// tile corners and no artwork. Declaring maskable on an icon that did NOT
// have that headroom is how apps end up with their logo shaved off.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${APP_NAME} — Pokémon card scanner & deck builder`,
    short_name: APP_NAME,
    description:
      "Scan a pile of cards from one photo, track what your collection is worth, and build decks from the cards you actually own.",
    // Both "/" so a launched app opens on the collection and stays inside
    // the app for every link it can serve.
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // The brand's dark tile: what the phone paints while the app boots, so
    // the launch doesn't flash white on a dark UI.
    background_color: "#16171B",
    theme_color: "#16171B",
    categories: ["utilities", "productivity", "entertainment"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
    // Long-press the home-screen icon. Scanning is the thing people open the
    // app to do, so it goes first.
    shortcuts: [
      { name: "Scan cards", short_name: "Scan", url: "/scan" },
      { name: "My collection", short_name: "Collection", url: "/" },
      { name: "My decks", short_name: "Decks", url: "/decks" },
    ],
  };
}
