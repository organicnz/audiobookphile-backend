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
    // 3. Fetch Libraries (/libraries)
    const librariesResponse = await fetch(`${API_BASE_URL}/libraries`, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });
    assertEquals(
      librariesResponse.status,
      200,
      "/libraries should return 200 OK",
    );
    const librariesBody = await librariesResponse.json();
    assertEquals(
      Array.isArray(librariesBody?.libraries || librariesBody),
      true,
      "/libraries should return an array",
    );

    const libraries = Array.isArray(librariesBody)
      ? librariesBody
      : librariesBody.libraries || [];

    if (libraries.length === 0) {
      console.warn(
        "No libraries found for the test user. Skipping item and progress checks.",
      );
      return;
    }

    const libraryId = libraries[0].id;

    // 4. Fetch Items for the first Library (/libraries/:id/items)
    const itemsResponse = await fetch(
      `${API_BASE_URL}/libraries/${libraryId}/items?limit=10`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      },
    );
    assertEquals(
      itemsResponse.status,
      200,
      `/libraries/${libraryId}/items should return 200 OK`,
    );
    const itemsBody = await itemsResponse.json();
    const items = Array.isArray(itemsBody)
      ? itemsBody
      : itemsBody.results || itemsBody.items || [];

    if (items.length === 0) {
      console.warn(
        "No items found in the library. Skipping item detail and progress checks.",
      );
      return;
    }

    const itemId = items[0].id;

    // 5. Fetch Item Details (/items/:id)
    const itemDetailResponse = await fetch(`${API_BASE_URL}/items/${itemId}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });
    assertEquals(
      itemDetailResponse.status,
      200,
      `/items/${itemId} should return 200 OK`,
    );
    const itemDetailBody = await itemDetailResponse.json();
    assertEquals(
      itemDetailBody.id,
      itemId,
      "Item detail should match requested ID",
    );

    // 6. Fetch Progress (/me/progress/:id)
    const progressResponse = await fetch(
      `${API_BASE_URL}/me/progress/${itemId}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      },
    );
    // Progress may return 404 if no progress exists, or 200 if it does.
    // For a smoke test, we just want to make sure it doesn't 500.
    const isProgressOk = progressResponse.status === 200 ||
      progressResponse.status === 404;
    assertEquals(
      isProgressOk,
      true,
      `/me/progress/${itemId} should return 200 or 404, got ${progressResponse.status}`,
    );
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
