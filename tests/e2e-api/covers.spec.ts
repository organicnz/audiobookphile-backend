import { expect, test } from "@playwright/test";
import { admin, deleteItem, type FixtureItem, seedItem } from "./fixtures";

/**
 * Cover pipeline, fully fixture-isolated: seed an item whose cover object we
 * upload ourselves, so assertions never depend on production data state.
 */
let item: FixtureItem;
const PNG_1PX = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

test.beforeAll(async () => {
  item = await seedItem({ title: "PW Cover Fixture", tracks: [] });
  const up = await admin.storage.from("covers").upload(
    `${item.id}/cover.png`,
    PNG_1PX,
    {
      upsert: true,
      contentType: "image/png",
    },
  );
  if (up.error && !up.error.message.includes("exists")) {
    throw new Error(up.error.message);
  }
  await admin.from("library_items").update({
    cover_path: `${item.id}/cover.png`,
  }).eq("id", item.id);
});

test.afterAll(async () => {
  if (!item) return;
  await admin.storage.from("covers").remove([`${item.id}/cover.png`]);
  await deleteItem(item.id).catch(() => {});
});

test("item with stored cover redirects to a servable image", async ({ request }) => {
  const res = await request.get(`/functions/v1/api/items/${item.id}/cover`, {
    maxRedirects: 0,
  });
  expect([200, 302]).toContain(res.status());
  if (res.status() === 302) {
    expect((res.headers()["location"] ?? "").length).toBeGreaterThan(10);
  } else {
    expect(res.headers()["content-type"] ?? "").toMatch(/image\//);
  }
});

test("unknown item cover is a clean 404", async ({ request }) => {
  const res = await request.get(
    "/functions/v1/api/items/11111111-2222-4333-8444-555555555555/cover",
  );
  expect(res.status()).toBe(404);
});
