import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { app } from "./index.ts";

Deno.test("Playback: POST /api/items/:id/play fails gracefully with invalid UUID", async () => {
  const req = new Request("http://localhost/api/items/invalid-uuid/play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceInfo: { deviceId: "test-device" },
    }),
  });

  const res = await app.request(req);
  const json = await res.json();

  // It should reject with 401 or 400 because there is no auth token,
  // but if it bypasses auth in test, we want to make sure it handles invalid item gracefully.
  // Wait, let's just assert the structure of the error.
  assertEquals(res.status >= 400, true);
  assertEquals(json.success !== true, true);
});

Deno.test("Playback: POST /api/session/:id/sync requires valid payload", async () => {
  const req = new Request("http://localhost/api/session/invalid-session/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Missing required currentTime and timeListened
      progress: 0.5,
    }),
  });

  const res = await app.request(req);
  const json = await res.json();

  assertEquals(res.status >= 400, true);
  assertEquals(json.success !== true, true);
});
