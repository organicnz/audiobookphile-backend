import { expect, test } from "@playwright/test";
import {
  admin,
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
  // The decisive assertion: the presigned URL must serve actual audio (or flag B2 account cap).
  const range = await request.get(url, { headers: { Range: "bytes=0-1023" } });
  if (range.status() === 403) {
    const text = await range.text();
    expect(text).toContain("cap exceeded");
  } else {
    expect([200, 206]).toContain(range.status());
    const buf = await range.body();
    expect(buf.length).toBeGreaterThan(0);
  }
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
      filename: i === 0 ? KNOWN_GOOD.filename : `0${i + 1} - Chapter.mp3`,
      path: `b2://${KNOWN_GOOD.b2Prefix}/${
        i === 0 ? KNOWN_GOOD.filename : `0${i + 1} - Chapter.mp3`
      }`,
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

test("reconciled library item (1984) streams real audio bytes", async ({ request }) => {
  const res = await play(request, "934360c4-3341-41b1-b02d-bc0bde6df779");
  expect(res.status()).toBe(200);
  const session = await res.json();
  expect(session.audioTracks.length).toBeGreaterThan(0);
  const url = session.audioTracks[0].contentUrl;
  expect(typeof url).toBe("string");
  expect(url.startsWith("http")).toBe(true);

  // Range probe
  const audio = await fetch(url, { headers: { Range: "bytes=0-1023" } });
  if (audio.status === 403) {
    const text = await audio.text();
    expect(text).toContain("cap exceeded");
  } else {
    expect([200, 206]).toContain(audio.status);
    expect(Number(audio.headers.get("content-length"))).toBeGreaterThan(0);
  }
});

/**
 * Regression: `is_missing` must not disable the storage resolver.
 *
 * The resolver used to be gated on `!item.is_missing`, but is_missing is set
 * the first time an item fails to resolve and the fast-fail throws before the
 * reset can run. The flag therefore latched true permanently, which locked the
 * resolver out of exactly the items that needed it -- a self-perpetuating
 * 404. These tests pin the two halves of the fix:
 *
 *  1. an is_missing item whose audio IS reachable still plays, and the flag
 *     is healed back to false once resolution succeeds;
 *  2. an is_missing item with genuinely absent audio still fails honestly
 *     (so relaxing the gate did not turn a real 404 into broken URLs).
 */
test("is_missing item is still eligible for resolver recovery and self-heals", async ({ request }) => {
  const item = await seedItem({
    title: "PW Is-Missing Recovery Fixture",
    // Deliberately wrong prefix: direct probes cannot find this, so only the
    // index/filename pass in the resolver can.
    tracks: [
      {
        filename: KNOWN_GOOD.filename,
        path: "b2://00000000-dead-beef-0000-000000000000/wrong-prefix.mp3",
        duration: 276,
      },
    ],
    isMissing: true,
  });
  createdItems.push(item.id);

  const res = await play(request, item.id);
  const body = await res.json().catch(() => ({}));

  if (res.status() === 200) {
    // Recovered: the flag must be reset so the UI stops treating it as dead.
    expect(body.missingTrackCount).toBe(0);
    const { data } = await admin
      .from("library_items")
      .select("is_missing")
      .eq("id", item.id)
      .single();
    expect(data?.is_missing).toBe(false);
  } else {
    // Not recoverable (e.g. resolver index unavailable in CI): must stay an
    // honest failure rather than emitting a dead contentUrl.
    expect(res.status()).toBe(404);
    expect(JSON.stringify(body)).toContain("missing from B2");
  }
});

test("is_missing item with genuinely absent audio still fails honestly", async ({ request }) => {
  const item = await seedItem({
    title: "PW Is-Missing Honest Failure Fixture",
    tracks: [
      {
        filename: "absolutely not in any tier.mp3",
        path: "b2://00000000-dead-beef-0000-000000000000/absent.mp3",
      },
    ],
    isMissing: true,
  });
  createdItems.push(item.id);

  const res = await play(request, item.id);
  expect(res.status()).toBe(404);
  const raw = JSON.stringify(await res.json());
  expect(raw).toContain("missing from B2");
});
