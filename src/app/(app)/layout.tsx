import Link from "next/link";
import { Suspense } from "react";
import { getUserAndProfile } from "@/lib/auth";
import { APP_NAME, FAN_DISCLAIMER } from "@/lib/branding";
import { TRADING_ENABLED } from "@/lib/features";
import { FanMark, Wordmark } from "@/components/Logo";
import HeaderCredits from "@/components/HeaderCredits";
import AppNav from "@/components/AppNav";
import TrainerChat from "@/components/TrainerChat";
import UpgradeReturn from "@/components/UpgradeReturn";
import SiteNotice from "@/components/SiteNotice";
import { initialsFor } from "@/lib/avatar";

/** The signed-in app shell, per App Screens artboard 02: dark bar with the
 *  nav sitting on its full height, the active item underlined in the
 *  highlight, locks on plan-gated items, credits pill and avatar at the
 *  right. Logged-out visitors reach exactly two routes in this group — the
 *  landing at "/" and /terms — and both bring their own shells. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getUserAndProfile();

  if (!auth) return <>{children}</>;

  const isAdmin = auth.profile?.role === "admin";
  const plan = auth.profile?.plan ?? "free";
  // The lock marks what the free plan doesn't include. Neither page hard-
  // blocks: both run on trial credits — the lock is the plan pitch, not a
  // wall, and the real limit is the credit balance, shown per action.
  //
  // Battle carries no lock. Anyone can play anyone; it is two people and a
  // shared table, with no model call anywhere in it, so there is nothing to
  // meter and nothing to sell. (Practice against the bot is a separate,
  // admin-only thing — see /api/battles.) If AI-driven battles arrive later,
  // that feature can be gated on its own terms rather than the whole page.
  const locked = !isAdmin && plan === "free";

  const navItems = [
    { label: "Collection", href: "/" },
    { label: "Scan", href: "/scan", locked },
    { label: "Decks", href: "/decks" },
    { label: "Battle", href: "/battles" },
    { label: "Grade", href: "/grade", locked },
    { label: "Friends", href: "/friends" },
    ...(TRADING_ENABLED ? [{ label: "Trades", href: "/trades" }] : []),
    ...(isAdmin ? [{ label: "Admin", href: "/admin" }] : []),
  ];

  return (
    <>
      <header className="sticky top-0 z-40 bg-brand-ink text-white shadow">
        <div className="mx-auto flex max-w-[1060px] items-stretch gap-3 px-4 sm:gap-5 sm:px-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 py-3.5"
            aria-label={APP_NAME}
          >
            <FanMark size={22} reversed />
            <span className="hidden sm:inline">
              <Wordmark reversed className="text-base" />
            </span>
          </Link>

          <AppNav items={navItems} />

          <div className="ml-auto flex shrink-0 items-center gap-2.5 py-2.5">
            {isAdmin ? (
              <span className="hidden rounded-full border border-dark-line3 bg-dark-tile px-3 py-1 font-mono text-[11.5px] text-dark-ink3 sm:inline">
                admin · unmetered
              </span>
            ) : (
              <HeaderCredits />
            )}
            {/* The avatar was a dead span. It's the conventional way into
                account settings, and there was no other route there. */}
            <Link
              href="/settings/account"
              aria-label="Account settings"
              title={`Account settings${auth.profile?.email ? ` · ${auth.profile.email}` : ""}`}
              className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-brand-accent text-[12.5px] font-bold text-white hover:brightness-110"
            >
              {initialsFor(auth.profile?.display_name, auth.profile?.email)}
            </Link>
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
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      </header>
      {/* pb leaves room for the chat launcher so it never sits on the footer */}
      {/* Above the content and below the nav: an outage notice that scrolls
          away with the page is a notice nobody reads. */}
      <SiteNotice />

      <main className="mx-auto max-w-[1060px] px-4 py-7 sm:px-6">
        {/* Suspense because it reads the query string, which opts the subtree
            out of static rendering — the boundary keeps that contained to
            the banner instead of the whole shell. */}
        <Suspense fallback={null}>
          <UpgradeReturn />
        </Suspense>
        {children}
      </main>
      <TrainerChat />
      <footer className="mx-auto max-w-[1060px] px-4 pb-24 pt-2 text-center text-xs text-slate-400 sm:px-6">
        <div>
          {APP_NAME} ·{" "}
          <Link href="/terms" className="hover:underline">
            Terms of Service
          </Link>
        </div>
        <p className="mx-auto mt-1.5 max-w-lg leading-snug">{FAN_DISCLAIMER}</p>
      </footer>
    </>
  );
}
