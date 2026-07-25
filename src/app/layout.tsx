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
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
              <Link href="/" className="flex items-center gap-2 font-bold">
                <span className="inline-block h-5 w-5 rounded-full border-2 border-white bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
                PokéDeck
              </Link>
              <nav className="flex items-center gap-1 text-sm">
                <Link href="/" className="rounded px-3 py-1.5 hover:bg-white/10">
                  Collection
                </Link>
                <Link href="/scan" className="rounded px-3 py-1.5 hover:bg-white/10">
                  Scan
                </Link>
                <Link href="/decks" className="rounded px-3 py-1.5 hover:bg-white/10">
                  Decks
                </Link>
                {auth.profile?.role === "admin" && (
                  <Link href="/admin" className="rounded px-3 py-1.5 hover:bg-white/10">
                    Admin
                  </Link>
                )}
                <form action="/api/auth/logout" method="post">
                  <button className="rounded px-3 py-1.5 text-white/70 hover:bg-white/10">
                    Sign out
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
