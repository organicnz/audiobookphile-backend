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
    const userEmail = meBody.email || meBody.user?.email;
    assertEquals(
      userEmail,
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

    // Prefer an item that has audio files and is not flagged missing
    const playableItem = items.find(
      (it: any) => !it.isMissing && it.isMissing !== true && !it.is_missing,
    );
    const itemId = playableItem ? playableItem.id : items[0].id;

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

    // 7. Start Playback Session (/items/:id/play)
    const playStartTime = Date.now();
    const playResponse = await fetch(`${API_BASE_URL}/items/${itemId}/play`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceInfo: { clientName: "Smoke Test Runner" },
        mediaPlayer: "smoke-test",
        forceDirectPlay: true,
      }),
    });
    const playElapsed = Date.now() - playStartTime;
    console.log(
      `[Smoke Test] /items/${itemId}/play completed in ${playElapsed}ms (status: ${playResponse.status})`,
    );

    // Must respond quickly (< 5000ms) without hanging or timing out
    assertEquals(
      playElapsed < 5000,
      true,
      `Playback initiation must complete in < 5000ms, took ${playElapsed}ms`,
    );

    // If item has audio files in storage it returns 200; if empty or missing files it returns 404.
    // In all cases it must NEVER return 500 or hang.
    const isPlayStatusValid = playResponse.status === 200 ||
      playResponse.status === 404;
    assertEquals(
      isPlayStatusValid,
      true,
      `/items/${itemId}/play returned unexpected status ${playResponse.status}`,
    );

    if (playResponse.status === 200) {
      const playBody = await playResponse.json();
      assertEquals(
        typeof playBody.id,
        "string",
        "Playback session must contain session ID",
      );
      assertEquals(
        Array.isArray(playBody.audioTracks),
        true,
        "Playback session must contain audioTracks array",
      );
      assertEquals(
        playBody.audioTracks.length > 0,
        true,
        "Playback session must contain at least 1 track",
      );
      assertEquals(
        typeof playBody.audioTracks[0].contentUrl,
        "string",
        "Track 0 must have contentUrl",
      );
      assertEquals(
        playBody.audioTracks[0].contentUrl.startsWith("http"),
        true,
        "contentUrl must be an HTTP signed URL",
      );

      // 8. Sync Progress (/session/:id/sync)
      const syncResponse = await fetch(
        `${API_BASE_URL}/session/${playBody.id}/sync`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            currentTime: 15,
            timeListened: 15,
            duration: playBody.duration || 100,
          }),
        },
      );
      assertEquals(
        syncResponse.status === 200,
        true,
        `/session/${playBody.id}/sync should return 200 OK, got ${syncResponse.status}`,
      );
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
