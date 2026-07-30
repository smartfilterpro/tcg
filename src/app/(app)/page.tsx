import { getUserAndProfile } from "@/lib/auth";
import CollectionHome from "./home-client";
import Landing from "@/components/marketing/Landing";

// "/" is two different pages: the collection for members, the marketing
// landing for everyone else. The middleware leaves "/" public so a stranger
// with the link sees a product, not a login wall.
export default async function Home() {
  const auth = await getUserAndProfile();
  if (!auth) return <Landing />;
  // CSV export is a paid feature, so the plan has to reach the client. Admins
  // are never gated.
  return (
    <CollectionHome
      plan={auth.profile?.plan ?? "free"}
      isAdmin={auth.profile?.role === "admin"}
    />
  );
}
