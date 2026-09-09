// Supabase client for Deno environment
import { createClient as supabaseCreate } from "@supabase/supabase-js";

export function createClient() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY");

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables",
    );
  }

  return supabaseCreate(SUPABASE_URL, {
    key: SUPABASE_KEY,
  });
}
