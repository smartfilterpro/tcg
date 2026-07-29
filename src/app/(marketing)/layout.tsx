import { MarketingNav, MarketingFooter } from "@/components/marketing/Chrome";

/** Marketing + auth shell. The landing at "/" lives in the (app) group (the
 *  route is shared with the collection) and mounts this chrome itself. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-brand-canvas font-body text-brand-ink">
      <MarketingNav />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
