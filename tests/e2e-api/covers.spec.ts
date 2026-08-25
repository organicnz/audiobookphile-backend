import { expect, test } from "@playwright/test";
import { KNOWN_GOOD } from "./fixtures";

/**
 * Cover pipeline: dynamic fetcher uploads gated art to Storage and the items
 * route redirects (302) to it; unknown/cover-less items fail gracefully.
 */

test("item with stored cover redirects to a servable image", async ({ request }) => {
  const res = await request.get(
    `/functions/v1/api/items/${KNOWN_GOOD.itemId}/cover`,
    { maxRedirects: 0 },
  );
  // Either a direct image or a 302 to signed storage URL - both acceptable.
  if (res.status() === 302) {
    const loc = res.headers()["location"] ?? "";
    expect(loc.length).toBeGreaterThan(10);
  } else {
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toMatch(/image\//);
  }
});

test("unknown item cover is a clean 404", async ({ request }) => {
  const res = await request.get(
    "/functions/v1/api/items/11111111-2222-4333-8444-555555555555/cover",
  );
  expect(res.status()).toBe(404);
});
