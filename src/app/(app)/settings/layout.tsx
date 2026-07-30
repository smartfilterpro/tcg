import Link from "next/link";

/** The settings shell: sidebar left, content right. The mock lists six
 *  sections; only the two that exist are rendered — dead sidebar links are
 *  worse than a shorter sidebar, and the rest arrive with their features. */
const SECTIONS = [
  { label: "Account", href: "/settings/account" },
  { label: "Billing", href: "/settings/billing" },
  { label: "Family", href: "/settings/family" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:gap-0">
      <nav className="shrink-0 rounded-xl bg-brand-panel-alt py-2 sm:w-[200px] sm:rounded-none sm:border-r sm:border-brand-line sm:py-6">
        <div className="flex gap-1 px-2 sm:flex-col sm:gap-0 sm:px-0">
          {SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="rounded-lg px-4 py-2.5 text-sm text-brand-ink3 hover:bg-brand-panel hover:text-brand-ink sm:rounded-none sm:border-l-[3px] sm:border-transparent sm:px-6"
            >
              {s.label}
            </Link>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1 sm:pl-8">{children}</div>
    </div>
  );
}
