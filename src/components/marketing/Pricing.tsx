// The pricing band: tier cards, the credit explainer + boost packs, and the
// FAQ. Rendered inside the landing page and standalone at /pricing.

import Link from "next/link";
import { BOOSTS, BOOSTS_NOTE, CREDIT_COSTS, CREDIT_COSTS_NOTE, FAQS, TIERS, FREE_LIMITS, FREE_LIMITS_NOTE } from "@/lib/marketing";
import { AI_NAME } from "@/lib/branding";

export function PricingSection() {
  return (
    <div id="pricing" className="border-y border-brand-line bg-brand-sunken">
      <div className="mx-auto max-w-[1200px] px-[18px] py-14 min-[1000px]:px-8 min-[720px]:py-[88px]">
        <div className="mx-auto mb-11 max-w-[56ch] text-center">
          <div className="mb-3.5 font-mono text-[11px] uppercase tracking-[.12em] text-brand-ink5">Pricing</div>
          <h2 className="m-0 mb-3.5 font-display text-[30px] font-bold leading-[1.08] tracking-[-.03em] min-[720px]:text-[42px]">
            Collecting is free. AI is metered.
          </h2>
          <p className="m-0 text-[16.5px] leading-[1.6] text-brand-ink2">
            Adding cards, tracking value and building decks by hand cost nothing, forever. Trainer
            AI runs on real compute, so it runs on credits — and you can always see exactly where
            they went.
          </p>
        </div>

        {/* tier cards */}
        <div className="grid grid-cols-1 items-start gap-4 min-[720px]:grid-cols-3">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className={`relative flex flex-col gap-[18px] rounded-[20px] border-[1.5px] p-[22px] min-[720px]:p-[30px] ${
                t.dark
                  ? "border-brand-ink bg-brand-ink text-brand-canvas"
                  : "border-brand-line bg-brand-panel text-brand-ink"
              }`}
            >
              {t.featured && (
                <span className="absolute -top-[11px] left-[30px] rounded-full bg-brand-highlight px-3 py-1 font-mono text-[10.5px] font-medium tracking-[.06em] text-brand-ink">
                  MOST POPULAR
                </span>
              )}
              <div>
                <div className="font-display text-[19px] font-bold tracking-[-.02em]">{t.name}</div>
                <div className={`mt-1 text-[13.5px] leading-[1.5] ${t.dark ? "text-dark-ink3" : "text-brand-ink3"}`}>
                  {t.who}
                </div>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-[46px] font-bold tracking-[-.04em]">{t.price}</span>
                <span className={`text-[14px] ${t.dark ? "text-dark-ink3" : "text-brand-ink3"}`}>{t.per}</span>
              </div>
              <div className={`rounded-xl px-3.5 py-3 ${t.dark ? "bg-dark-tile" : "bg-brand-sunken"}`}>
                <div className="font-display text-[15px] font-bold">{t.credits}</div>
                <div className={`mt-0.5 text-[12.5px] leading-[1.5] ${t.dark ? "text-dark-ink3" : "text-brand-ink3"}`}>
                  {t.creditsNote}
                </div>
              </div>
              <div className="flex flex-col gap-[9px]">
                {t.features.map((feat) => (
                  <div key={feat.text} className="flex items-start gap-[9px] text-[14px] leading-[1.5]">
                    <span
                      className={`mt-px shrink-0 font-mono text-[12px] ${
                        feat.included ? (t.dark ? "text-brand-highlight" : "text-brand-accent") : "text-brand-ink5"
                      }`}
                    >
                      {feat.included ? "✓" : "—"}
                    </span>
                    <span className={feat.included ? "" : "text-brand-ink5"}>{feat.text}</span>
                  </div>
                ))}
              </div>
              <Link
                href={t.href}
                className={`mt-auto w-full rounded-full border px-3 py-[13px] text-center text-[15px] font-medium transition-colors ${
                  t.featured
                    ? "border-brand-highlight bg-brand-highlight text-brand-ink hover:brightness-95"
                    : t.dark
                      ? "border-brand-canvas/30 bg-transparent text-brand-canvas hover:bg-white/10"
                      : "border-brand-line-strong bg-brand-panel text-brand-ink hover:bg-brand-sunken"
                }`}
              >
                {t.cta}
              </Link>
            </div>
          ))}
        </div>

        {/* What free does NOT do.
            Its own block rather than more crosses in the Free column: the
            crosses are read as a comparison between tiers, and this is the
            question somebody asks on its own — "what will stop me?" — which
            deserves a plain answer in one place instead of being inferred
            from three lists. */}
        <div className="mt-5 rounded-[20px] border border-brand-line bg-brand-panel p-[22px] min-[720px]:p-[30px]">
          <h3 className="m-0 mb-1.5 font-display text-[19px] font-bold tracking-[-.02em]">
            What the free plan won&apos;t let you do
          </h3>
          <p className="m-0 mb-3.5 max-w-[62ch] text-[14px] leading-[1.6] text-brand-ink3">
            Short list, and worth reading before you sign up rather than after.
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {FREE_LIMITS.map((limit) => (
              <li key={limit} className="flex items-start gap-[9px] text-[14.5px] leading-[1.5]">
                <span className="mt-px shrink-0 font-mono text-[12px] text-brand-ink5">—</span>
                <span className="text-brand-ink2">{limit}</span>
              </li>
            ))}
          </ul>
          <p className="mb-0 mt-3.5 max-w-[62ch] text-[13px] leading-[1.55] text-brand-ink5">
            {FREE_LIMITS_NOTE}
          </p>
        </div>

        {/* credits explainer + boosts */}
        <div className="mt-5 rounded-[20px] border border-brand-line bg-brand-panel p-[22px] min-[720px]:p-[30px]">
          <div className="flex flex-wrap gap-11">
            <div className="min-w-[280px] flex-[1_1_320px]">
              <h3 className="m-0 mb-2 font-display text-[23px] font-bold tracking-[-.02em]">What a credit is</h3>
              <p className="m-0 mb-[18px] text-[14.5px] leading-[1.6] text-brand-ink3 [text-wrap:pretty]">
                Credits are what {AI_NAME} runs on. Each request costs what it actually takes to
                run — the table below is what to expect — and every charge shows in your history.
                No mystery tokens, no surprise bill. Run out and nothing breaks: your collection,
                decks and battles keep working.
              </p>
              <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-brand-line">
                {CREDIT_COSTS.map((c, i) => (
                  <div
                    key={c.action}
                    className={`flex items-center justify-between gap-4 px-3.5 py-[11px] ${
                      i % 2 ? "bg-brand-canvas" : "bg-brand-panel"
                    }`}
                  >
                    <span className="text-[14px]">{c.action}</span>
                    <span className="whitespace-nowrap font-mono text-[12.5px] text-brand-ink2">{c.cost}</span>
                  </div>
                ))}
              </div>
              <p className="mb-0 mt-2 text-[12px] leading-[1.5] text-brand-ink5">{CREDIT_COSTS_NOTE}</p>
            </div>
            <div className="min-w-[280px] flex-[1_1_320px]">
              <h3 className="m-0 mb-2 font-display text-[23px] font-bold tracking-[-.02em]">Need more? Boost.</h3>
              <p className="m-0 mb-[18px] text-[14.5px] leading-[1.6] text-brand-ink3 [text-wrap:pretty]">
                Big weekend, new set drop, someone dumped a shoebox on your table. Buy credits when
                you need them — they never expire while your plan is active.
              </p>
              <div className="flex flex-col gap-2">
                {BOOSTS.map((b) => (
                  <div
                    key={b.pack}
                    className={`flex items-center justify-between gap-3.5 rounded-[14px] border px-4 py-3.5 ${
                      b.best ? "border-brand-accent bg-brand-accent-tint" : "border-brand-line bg-brand-panel"
                    }`}
                  >
                    <div>
                      <div className="font-display text-[16px] font-bold">{b.credits}</div>
                      <div className="mt-px text-[12.5px] text-brand-ink3">{b.note}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-display text-[19px] font-bold">{b.price}</span>
                    </div>
                  </div>
                ))}
                {/* The mock advertised auto-boost here. It needs off-session
                    Stripe charging, which doesn't exist yet, so promising it
                    on the pricing page would be selling something we can't
                    deliver. This says something true instead. */}
                <p className="mb-0 mt-1.5 text-[13px] leading-[1.55] text-brand-ink3">
                  {BOOSTS_NOTE}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* FAQ */}
        <div className="mt-11 grid grid-cols-1 gap-5 min-[720px]:grid-cols-2 min-[720px]:gap-x-11 min-[720px]:gap-y-4">
          {FAQS.map((f) => (
            <div key={f.q} className="border-t border-brand-line-strong pt-4">
              <div className="font-display text-[16.5px] font-bold tracking-[-.01em]">{f.q}</div>
              <p className="mb-0 mt-1.5 text-[14.5px] leading-[1.6] text-brand-ink3 [text-wrap:pretty]">{f.a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
