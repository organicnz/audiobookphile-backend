import { expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteItem,
  deleteTestUser,
  KNOWN_GOOD,
  loginUser,
  seedItem,
  type TestUser,
} from "./fixtures";

/**
 * End-to-end proof of the playback self-heal pipeline against REAL storage:
 *
 *  - live: a scheme'd b2:// path pointing at an object that actually exists
 *    must produce a session whose first track serves audio bytes (206).
 *  - dead: a scheme'd path that exists nowhere must yield the honest
 *    "All audio files are missing" 404 - never silent broken URLs.
 */

let user: TestUser;
const createdItems: string[] = [];

test.beforeAll(async () => {
  user = await createTestUser("e2e-play");
  user.token = await loginUser(user.email, user.password);
});

test.afterAll(async () => {
  for (const id of createdItems) await deleteItem(id).catch(() => {});
  if (user?.id) await deleteTestUser(user.id);
});

function play(
  request: import("@playwright/test").APIRequestContext,
  itemId: string,
) {
  return request.post(`/functions/v1/api/items/${itemId}/play`, {
    headers: { Authorization: `Bearer ${user.token}` },
    data: { deviceInfo: { name: "pw-e2e" } },
  });
}

test("live scheme'd track resolves and streams real bytes", async ({ request }) => {
  const item = await seedItem({
    title: "PW Live Track Fixture",
    tracks: [
      {
        filename: KNOWN_GOOD.filename,
        path: `b2://${KNOWN_GOOD.b2Prefix}/${KNOWN_GOOD.filename}`,
        duration: 276,
      },
    ],
  });
  createdItems.push(item.id);

  const res = await play(request, item.id);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.missingTrackCount).toBe(0);
  expect(body.audioTracks.length).toBe(1);

  const url = body.audioTracks[0].contentUrl as string;
  expect(url.startsWith("http")).toBe(true);
  // The decisive assertion: the presigned URL must serve actual audio.
  const range = await request.get(url, { headers: { Range: "bytes=0-1023" } });
  expect([200, 206]).toContain(range.status());
  const buf = await range.body();
  expect(buf.length).toBeGreaterThan(0);
});

test("dead scheme'd track yields honest 'all missing' failure, not broken URLs", async ({ request }) => {
  const item = await seedItem({
    title: "PW Dead Track Fixture",
    tracks: [
      {
        filename: "does not exist anywhere.mp3",
        path: "b2://00000000-dead-beef-0000-000000000000/gone.mp3",
      },
    ],
  });
  createdItems.push(item.id);

  const res = await play(request, item.id);
  expect(res.status()).toBe(404);
  const raw = JSON.stringify(await res.json());
  expect(raw).toContain("missing from storage");
});

test("partial book surfaces missingTrackCount for surviving tracks", async ({ request }) => {
  const item = await seedItem({
    title: "PW Mixed Fixture",
    tracks: [
      {
        filename: "gone forever.mp3",
        path: "b2://00000000-dead-beef-0000-000000000000/nope.mp3",
      },
      {
        filename: KNOWN_GOOD.filename,
        path: `b2://${KNOWN_GOOD.b2Prefix}/${KNOWN_GOOD.filename}`,
        duration: 276,
      },
    ],
  });
  createdItems.push(item.id);

  const res = await play(request, item.id);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.missingTrackCount).toBe(1);
  expect(body.audioTracks.length).toBe(1);
});

test("playback of unknown item is a clean 404", async ({ request }) => {
  const res = await play(
    request,
    "11111111-1111-4111-8111-111111111111",
  );
  expect([404]).toContain(res.status());
});
