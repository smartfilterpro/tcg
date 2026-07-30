import { getUserAndProfile } from "@/lib/auth";
import CollectionHome from "./home-client";
import Landing from "@/components/marketing/Landing";
import { liveStats, statsNote } from "@/lib/liveStats";

// "/" is two different pages: the collection for members, the marketing
// landing for everyone else. The middleware leaves "/" public so a stranger
// with the link sees a product, not a login wall.
export default async function Home() {
  const auth = await getUserAndProfile();
  if (!auth) {
    // Measured on the server so a stranger's first paint already has them —
    // numbers that pop in after the hero has rendered read as an ad.
    const { stats, measuredFrom } = await liveStats();
    return <Landing stats={stats} statsNote={statsNote(measuredFrom)} />;
  }
  // CSV export is a paid feature, so the plan has to reach the client. Admins
  // are never gated.
  return (
    <CollectionHome
      plan={auth.profile?.plan ?? "free"}
      isAdmin={auth.profile?.role === "admin"}
    />
  );
}
