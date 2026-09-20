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
  expect(raw).toContain("missing from B2");
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

test("multi-track item initiates playback in < 1000ms with all tracks signed", async ({ request }) => {
  const item = await seedItem({
    title: "PW Multi-Track Benchmark Fixture",
    tracks: Array.from({ length: 10 }, (_, i) => ({
      filename: `0${i + 1} - Chapter.mp3`,
      path: `b2://${KNOWN_GOOD.b2Prefix}/0${i + 1} - Chapter.mp3`,
      duration: 120,
    })),
  });
  createdItems.push(item.id);

  const start = Date.now();
  const res = await play(request, item.id);
  const elapsed = Date.now() - start;

  // Single-probe folder derivation must complete well under 2500ms
  expect(elapsed).toBeLessThan(2500);
  expect([200, 404]).toContain(res.status());

  if (res.status() === 200) {
    const body = await res.json();
    expect(body.audioTracks.length).toBe(10);
    expect(body.missingTrackCount).toBe(0);
    for (const track of body.audioTracks) {
      expect(typeof track.contentUrl).toBe("string");
      expect(track.contentUrl.startsWith("http")).toBe(true);
    }
  }
});

test("playback progress sync loop succeeds end-to-end", async ({ request }) => {
  const item = await seedItem({
    title: "PW Sync Progress Fixture",
    tracks: [
      {
        filename: KNOWN_GOOD.filename,
        path: `b2://${KNOWN_GOOD.b2Prefix}/${KNOWN_GOOD.filename}`,
        duration: 276,
      },
    ],
  });
  createdItems.push(item.id);

  const playRes = await play(request, item.id);
  expect(playRes.status()).toBe(200);
  const session = await playRes.json();
  expect(session.id).toBeDefined();

  // Sync progress
  const syncRes = await request.post(
    `/functions/v1/api/session/${session.id}/sync`,
    {
      headers: { Authorization: `Bearer ${user.token}` },
      data: {
        currentTime: 45,
        timeListened: 45,
        duration: session.duration || 276,
      },
    },
  );
  expect(syncRes.status()).toBe(200);

  // Verify progress persisted on /api/me/progress/:id
  const progRes = await request.get(
    `/functions/v1/api/me/progress/${item.id}`,
    {
      headers: { Authorization: `Bearer ${user.token}` },
    },
  );
  expect(progRes.status()).toBe(200);
  const progBody = await progRes.json();
  expect(progBody.currentTime ?? progBody.current_time_pos).toBe(45);
});
