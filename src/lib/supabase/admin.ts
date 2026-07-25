import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/** Service-role client — bypasses RLS. Server-side only. */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
