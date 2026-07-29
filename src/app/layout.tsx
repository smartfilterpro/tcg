import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import { getUserAndProfile } from "@/lib/auth";

// The display face for the wordmark and headings. next/font rather than a
// <link> as the design bundle used: it self-hosts the file, so there's no
// third-party request and no flash of fallback type on the logo.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PokéDeck — scan, collect, battle",
  description: "Scan your Pokémon cards, track your collection, and build decks with Trainer AI.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const auth = await getUserAndProfile();

  return (
    <html lang="en" className={display.variable}>
      <body className="min-h-screen">
        {auth && (
          <header className="sticky top-0 z-40 bg-poke-dark text-white shadow">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-3 sm:px-4">
              <Link href="/" className="flex shrink-0 items-center gap-2 font-bold">
                <span className="inline-block h-5 w-5 rounded-full border-2 border-white bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
                <span className="hidden sm:inline">PokéDeck</span>
              </Link>
              {/* Scrolls sideways on narrow screens instead of pushing items off-screen */}
              <nav className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm">
                <Link
                  href="/"
                  className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                >
                  Collection
                </Link>
                <Link
                  href="/scan"
                  className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                >
                  Scan
                </Link>
                <Link
                  href="/decks"
                  className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                >
                  Decks
                </Link>
                <Link
                  href="/battles"
                  className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                >
                  Battle
                </Link>
                <Link
                  href="/grade"
                  className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                >
                  Grade
                </Link>
                <Link
                  href="/friends"
                  className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                >
                  Friends
                </Link>
                {auth.profile?.role === "admin" && (
                  <Link
                    href="/admin"
                    className="whitespace-nowrap rounded px-2 py-1.5 hover:bg-white/10 sm:px-3"
                  >
                    Admin
                  </Link>
                )}
                <Link
                  href="/support"
                  aria-label="Help & support"
                  title="Help & support"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10"
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </Link>
                <form action="/api/auth/logout" method="post" className="shrink-0">
                  <button
                    aria-label="Sign out"
                    title="Sign out"
                    className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10"
                  >
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                  </button>
                </form>
              </nav>
            </div>
          </header>
        )}
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 pt-2 text-center text-xs text-slate-400">
          PokéDeck ·{" "}
          <Link href="/terms" className="hover:underline">
            Terms of Service
          </Link>
        </footer>
      </body>
    </html>
  );
}
