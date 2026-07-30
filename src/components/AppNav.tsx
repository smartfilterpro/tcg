"use client";

// The app bar's nav, per App Screens artboard 02: items sit on the bar's
// full height, the active one carries the highlight underline, and gated
// items wear a small lock. Client component only because the underline
// needs the pathname.

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AppNavItem {
  label: string;
  href: string;
  locked?: boolean;
}

export default function AppNav({ items }: { items: AppNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="no-scrollbar ml-2 flex min-w-0 items-stretch gap-0.5 self-stretch overflow-x-auto text-sm">
      {items.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 ${
              active
                ? "border-brand-highlight text-white"
                : "border-transparent text-dark-ink3 hover:text-white"
            }`}
          >
            {item.label}
            {item.locked && <span className="text-[10px] opacity-65">🔒</span>}
          </Link>
        );
      })}
    </nav>
  );
}
