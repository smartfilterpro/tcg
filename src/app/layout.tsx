import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { getUserAndProfile } from "@/lib/auth";

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
    <html lang="en">
      <body className="min-h-screen">
        {auth && (
          <header className="sticky top-0 z-40 bg-poke-dark text-white shadow">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-3 sm:px-4">
              <Link href="/" className="flex shrink-0 items-center gap-2 font-bold">
                <span className="inline-block h-5 w-5 rounded-full border-2 border-white bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
                <span className="hidden sm:inline">PokéDeck</span>
              </Link>
              <nav className="flex items-center gap-0.5 text-sm">
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
                  className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10"
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
      </body>
    </html>
  );
}
