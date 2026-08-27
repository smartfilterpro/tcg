import { redirect } from "next/navigation";
import { getUserAndProfile } from "@/lib/auth";

/** Battles are retired from the member app but kept, intact, for the admin.
 *  This layout is the page-side lock: the engine, the board and the API
 *  underneath are untouched — members simply can't get here any more (the
 *  nav link is admin-only too, and every /api/battles route refuses
 *  non-admins on its own). */
export default async function BattlesLayout({ children }: { children: React.ReactNode }) {
  const auth = await getUserAndProfile();
  if (auth?.profile?.role !== "admin") redirect("/");
  return <>{children}</>;
}
