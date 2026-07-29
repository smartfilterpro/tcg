// The marketing shell: sticky nav and dark footer, shared by the landing,
// pricing and auth pages. Server components — the nav needs auth state to
// swap "Start free" for "Open app".

import Link from "next/link";
import { getUserAndProfile } from "@/lib/auth";
import { APP_NAME, FAN_DISCLAIMER } from "@/lib/branding";
import { FanMark, Wordmark } from "@/components/Logo";

export async function MarketingNav() {
  const auth = await getUserAndProfile();
  return (
    <div className="sticky top-0 z-50 border-b border-brand-line bg-brand-canvas/90 backdrop-blur-[12px]">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 px-[18px] py-3.5 min-[1000px]:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label={APP_NAME}>
          <FanMark size={26} />
          <Wordmark className="text-[19px] text-brand-ink" />
        </Link>
        <nav className="flex items-center gap-1 text-[14.5px] text-brand-ink2">
          {/* Secondary links hide below 1000px so the CTA pill stays on one
              line — the mock's breakpoint, via an arbitrary variant. */}
          <Link href="/#scan" className="hidden whitespace-nowrap rounded-lg px-3 py-2 hover:bg-brand-sunken min-[1000px]:block">
            Bulk scan
          </Link>
          <Link href="/#ai" className="hidden whitespace-nowrap rounded-lg px-3 py-2 hover:bg-brand-sunken min-[1000px]:block">
            Trainer AI
          </Link>
          <Link href="/pricing" className="hidden whitespace-nowrap rounded-lg px-3 py-2 hover:bg-brand-sunken min-[1000px]:block">
            Pricing
          </Link>
          <Link href="/#families" className="hidden whitespace-nowrap rounded-lg px-3 py-2 hover:bg-brand-sunken min-[1000px]:block">
            For families
          </Link>
          {auth ? (
            <Link
              href="/"
              className="ml-1.5 whitespace-nowrap rounded-full bg-brand-ink px-5 py-2.5 font-medium text-brand-canvas transition-colors hover:bg-brand-accent"
            >
              Open app
            </Link>
          ) : (
            <>
              <Link href="/login" className="whitespace-nowrap px-3 py-2 text-brand-ink">
                Log in
              </Link>
              <Link
                href="/signup"
                className="ml-1.5 whitespace-nowrap rounded-full bg-brand-ink px-5 py-2.5 font-medium text-brand-canvas transition-colors hover:bg-brand-accent"
              >
                Start free
              </Link>
            </>
          )}
        </nav>
      </div>
    </div>
  );
}

/** Footer link columns. Only destinations that exist — the mock lists
 *  Privacy Policy, Refund policy, Status and Changelog, none of which are
 *  built yet; linking to nothing is worse than a shorter column. */
const FOOTER_COLS: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
  {
    title: "Product",
    links: [
      { label: "Bulk scan", href: "/#scan" },
      { label: "Trainer AI", href: "/#ai" },
      { label: "For families", href: "/#families" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Support",
    links: [{ label: "Help & contact", href: "/support" }],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms of Service", href: "/terms" },
      { label: "Fan-content notice", href: "/terms" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <div className="bg-brand-ink text-dark-ink3">
      <div className="mx-auto max-w-[1200px] px-[18px] pb-10 pt-[52px] min-[1000px]:px-8">
        <div className="flex flex-wrap justify-between gap-11">
          <div className="min-w-[240px] flex-[1_1_280px]">
            <div className="mb-3.5 flex items-center gap-2.5">
              <FanMark size={24} reversed />
              <Wordmark reversed className="text-[17px] text-brand-canvas" />
            </div>
            <p className="m-0 max-w-[40ch] text-[13px] leading-[1.65]">{FAN_DISCLAIMER}</p>
          </div>
          {FOOTER_COLS.map((col) => (
            <div key={col.title} className="flex-[0_1_150px]">
              <div className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[.1em] text-dark-ink5">
                {col.title}
              </div>
              <div className="flex flex-col gap-2.5">
                {col.links.map((l) => (
                  <Link key={l.label} href={l.href} className="text-[13.5px] text-dark-ink3 hover:text-brand-canvas">
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap justify-between gap-4 border-t border-dark-line2 pt-5 text-[12.5px]">
          <span>© 2026 {APP_NAME}. All rights reserved.</span>
        </div>
      </div>
    </div>
  );
}
