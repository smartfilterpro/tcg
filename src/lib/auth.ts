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
  if (result.profile?.suspended === true) {
    throw new AuthError("Your account is suspended — contact the admin.", 403);
  }
  // Terms acceptance is enforced at the API layer too — the middleware
  // redirect alone can be sidestepped by direct requests. Pre-migration-016
  // profiles (no column) skip the check.
  const p = result.profile as (typeof result.profile & { tos_accepted_at?: string | null }) | null;
  if (p && "tos_accepted_at" in p && p.tos_accepted_at == null) {
    throw new AuthError("Please accept the Terms of Service to continue.", 403);
  }
  return result;
}

export async function requireAdmin() {
  const result = await requireUser();
  if (result.profile?.role !== "admin") throw new AuthError("Admin only", 403);
  return result;
}

/** Admin OR moderator — content work only.
 *
 *  Deliberately a separate gate rather than a widened requireAdmin: every
 *  route that touches money, roles or deletion keeps calling requireAdmin,
 *  so adding a moderator can never quietly grant one of those. Returns the
 *  role so a shared route can still tell the two apart (the member list,
 *  for instance, hides spend from moderators). */
export async function requireModerator() {
  const result = await requireUser();
  const role = result.profile?.role;
  if (role !== "admin" && role !== "moderator") {
    throw new AuthError("Moderators only", 403);
  }
  return { ...result, isAdmin: role === "admin" };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    // Named so apiError can recognise it without importing this module —
    // which would drag next/headers into every library that reports a
    // failure, including ones that never see a request.
    this.name = "AuthError";
    this.status = status;
  }
}
