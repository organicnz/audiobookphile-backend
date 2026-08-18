import { assertEquals } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const TEST_EMAIL = Deno.env.get("TEST_EMAIL");
const TEST_PASSWORD = Deno.env.get("TEST_PASSWORD");
const API_BASE_URL = Deno.env.get("API_BASE_URL");

Deno.test({
  name: "Smoke Test: Authentication and Protected API",
  fn: async () => {
    if (
      !SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_EMAIL || !TEST_PASSWORD ||
      !API_BASE_URL
    ) {
      console.warn(
        "Skipping smoke test: Missing required environment variables (SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD, API_BASE_URL)",
      );
      return;
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    });

    // 1. Sign in
    const { data: authData, error: authError } = await supabase.auth
      .signInWithPassword({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });

    assertEquals(authError, null, "Authentication should succeed");
    assertEquals(authData?.session !== null, true, "Session should exist");

    const token = authData.session!.access_token;

    // 2. Fetch protected endpoint (/me)
    const meResponse = await fetch(`${API_BASE_URL}/me`, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    assertEquals(meResponse.status, 200, "/me should return 200 OK");
    const meBody = await meResponse.json();
    assertEquals(
      meBody.email,
      TEST_EMAIL,
      "/me response should contain the test email",
    );
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
