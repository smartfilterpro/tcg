import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import type { User } from "@supabase/supabase-js";

/** Returns the authenticated user + profile, or null. */
export async function getUserAndProfile(): Promise<{
  user: User;
  profile: Profile | null;
} | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  return { user, profile: (profile as Profile | null) ?? null };
}

export async function requireUser() {
  const result = await getUserAndProfile();
  if (!result) throw new AuthError("Not authenticated");
  return result;
}

export async function requireAdmin() {
  const result = await requireUser();
  if (result.profile?.role !== "admin") throw new AuthError("Admin only", 403);
  return result;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}
