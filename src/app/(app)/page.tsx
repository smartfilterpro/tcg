import { getUserAndProfile } from "@/lib/auth";
import CollectionHome from "./home-client";
import Landing from "@/components/marketing/Landing";

// "/" is two different pages: the collection for members, the marketing
// landing for everyone else. The middleware leaves "/" public so a stranger
// with the link sees a product, not a login wall.
export default async function Home() {
  const auth = await getUserAndProfile();
  if (!auth) return <Landing />;
  return <CollectionHome />;
}
