// Unit tests for the PlaybackService self-heal logic (the "black screen" fix).
//
// Strategy: drive PlaybackService.startSession() against a minimal fake
// supabase client while stubbing StorageRouter's storage primitives on the
// prototype. This exercises exactly the decision logic under test:
//   * scheme'd paths are existence-probed before being served
//   * dead paths trigger cross-tier/prefix re-resolution and DB patching
//   * unresolvable tracks become "missing" instead of silent 404 URLs
//   * legacy paths skip the probe (already verified by resolveAndSign)
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PlaybackService } from "./playbackService.ts";
import { StorageRouter } from "../_shared/storage-router.ts";

interface FakeResult {
  data: unknown;
  error: unknown;
}

type FakeClient = Record<string, unknown> & {
  __patchedAudioFiles: unknown[][];
};

/**
 * Minimal chainable query builder covering every access pattern startSession
 * uses on the fake client.
 */
function chainable(result: FakeResult): Record<string, unknown> {
  const build = (): Record<string, unknown> =>
    new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (r: FakeResult) => void) => resolve(result);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve(result);
        }
        return () => build();
      },
    });
  return build();
}

type RealClient = Parameters<typeof PlaybackService.startSession>[0];

function fakeSupabase(item: Record<string, unknown>): RealClient {
  const patchedAudioFiles: unknown[][] = [];
  const client: Record<string, unknown> = {
    __patchedAudioFiles: patchedAudioFiles,
    from(table: string) {
      if (table === "library_items") {
        return {
          select(_cols?: string) {
            return {
              eq(_col: string, _val: string) {
                return {
                  maybeSingle: () =>
                    Promise.resolve({ data: item, error: null }),
                  single: () =>
                    Promise.resolve({
                      data: { audio_files: item.audio_files },
                      error: null,
                    }),
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            if (Array.isArray(patch.audio_files)) {
              patchedAudioFiles.push(patch.audio_files as unknown[]);
            }
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      // media_progress and anything else: no rows
      return chainable({ data: null, error: null });
    },
  };
  return client as unknown as RealClient;
}

// --- StorageRouter stubbing -------------------------------------------------

interface RouterControl {
  resolveAndSign: (path: string, itemId: string, expires: number) => Promise<{
    signedUrl: string;
    canonicalPath: string;
  }>;
  getSignedUrl: (path: string, expires: number) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
  signFirstExisting: (
    keys: string[],
    expires: number,
  ) => Promise<{ signedUrl: string; canonicalPath: string } | null>;
}

function stubStorage(control: Partial<RouterControl>): void {
  const proto = StorageRouter.prototype as unknown as Record<string, unknown>;
  proto.resolveAndSign = async (path: string, itemId: string) =>
    control.resolveAndSign ? control.resolveAndSign(path, itemId, 604800) : {
      signedUrl: `signed:${path}`,
      canonicalPath: `b2://${itemId}/${path}`,
    };
  proto.getSignedUrl = async (path: string) =>
    control.getSignedUrl
      ? control.getSignedUrl(path, 604800)
      : `signed:${path}`;
  proto.fileExists = async (path: string) =>
    control.fileExists ? control.fileExists(path) : true;
  proto.signFirstExisting = async (keys: string[]) =>
    control.signFirstExisting
      ? control.signFirstExisting(keys, 604800)
      : keys.length > 0
      ? { signedUrl: `healed:${keys[0]}`, canonicalPath: keys[0] }
      : null;
}

const ITEM_ID = "11111111-2222-3333-4444-555555555555";

function itemWith(audioFiles: Record<string, unknown>[]) {
  return {
    id: ITEM_ID,
    title: "Self Heal Fixture",
    library_id: "lib-1",
    media_type: "book",
    cover_path: null,
    duration: 100,
    audio_files: audioFiles,
    book_authors: [],
    book_series: [],
    chapters: [],
  };
}

Deno.test("self-heal: live scheme'd path is served without re-resolution", async () => {
  let probed = false;
  stubStorage({
    fileExists: () => {
      probed = true;
      return Promise.resolve(true);
    },
    signFirstExisting: () => {
      throw new Error("must not re-resolve when file exists");
    },
  });
  const session = await PlaybackService.startSession(
    fakeSupabase(itemWith([
      {
        duration: 10,
        metadata: { filename: "a.mp3", path: "b2://media/a.mp3" },
      },
    ])),
    "user-1",
    ITEM_ID,
  );
  assertEquals(probed, true);
  assertEquals(session.missingTrackCount, 0);
  assertEquals(session.audioTracks.length, 1);
});

Deno.test("self-heal: dead scheme'd path is re-resolved across candidate prefixes", async () => {
  const seenCandidates: string[][] = [];
  stubStorage({
    fileExists: () => Promise.resolve(false),
    signFirstExisting: (keys: string[]) => {
      seenCandidates.push(keys);
      // file actually lives under the recorded prefix (media_id), not item id
      return Promise.resolve({
        signedUrl: "healed-url",
        canonicalPath: keys.find((k) => k.startsWith("media-id/")) ?? keys[0],
      });
    },
    // Presigning is purely local math and must succeed even for dead objects
    // - that is precisely why the existence probe exists.
    getSignedUrl: (path: string) => Promise.resolve(`blind:${path}`),
  });
  const session = await PlaybackService.startSession(
    fakeSupabase(itemWith([
      {
        duration: 10,
        metadata: { filename: "a.mp3", path: "b2://media-id/a.mp3" },
      },
    ])),
    "user-1",
    ITEM_ID,
  );
  assertEquals(seenCandidates.length, 1);
  // candidates must include both the item-id key and the recorded-prefix key
  assertEquals(seenCandidates[0].includes(`${ITEM_ID}/a.mp3`), true);
  assertEquals(seenCandidates[0].includes("media-id/a.mp3"), true);
  assertEquals(session.missingTrackCount, 0);
  assertEquals(
    (session.audioTracks[0] as Record<string, unknown>).contentUrl,
    "healed-url",
  );
});

Deno.test("self-heal: unresolvable track becomes missing, honest 404 when none survive", async () => {
  stubStorage({
    fileExists: () => Promise.resolve(false),
    signFirstExisting: () => Promise.resolve(null),
  });
  await assertRejects(
    () =>
      PlaybackService.startSession(
        fakeSupabase(itemWith([
          {
            duration: 10,
            metadata: { filename: "gone.mp3", path: "b2://x/gone.mp3" },
          },
        ])),
        "user-1",
        ITEM_ID,
      ),
    Error,
    "All audio files are missing",
  );
});

Deno.test("self-heal: partial book reports missingTrackCount instead of dropping content", async () => {
  stubStorage({
    // first track dead, second lives in an alternate tier
    fileExists: () => Promise.resolve(false),
    signFirstExisting: (keys: string[]) =>
      Promise.resolve(
        keys.some((k) => k.includes("live"))
          ? {
            signedUrl: "ok-url",
            canonicalPath: keys.find((k) => k.includes("live"))!,
          }
          : null,
      ),
    getSignedUrl: (path: string) =>
      path.includes("dead")
        ? Promise.reject(new Error("presign ok but object gone"))
        : Promise.resolve("unused"),
  });
  const session = await PlaybackService.startSession(
    fakeSupabase(itemWith([
      {
        duration: 10,
        metadata: { filename: "dead.mp3", path: "b2://p/dead.mp3" },
      },
      {
        duration: 20,
        metadata: { filename: "live.mp3", path: "b2://other/live.mp3" },
      },
    ])),
    "user-1",
    ITEM_ID,
  );
  assertEquals(session.missingTrackCount, 1);
  assertEquals(session.audioTracks.length, 1);
});

Deno.test("self-heal: legacy paths skip the probe - already verified by resolveAndSign", async () => {
  let probeCalls = 0;
  stubStorage({
    resolveAndSign: (path: string, itemId: string) =>
      Promise.resolve({
        signedUrl: "legacy-signed",
        canonicalPath: `b2-secondary://${itemId}/${path}`,
      }),
    fileExists: () => {
      probeCalls++;
      return Promise.resolve(false);
    },
  });
  const session = await PlaybackService.startSession(
    fakeSupabase(itemWith([
      {
        duration: 5,
        metadata: { filename: "l.mp3", path: "/audiobooks/Book/l.mp3" },
      },
    ])),
    "user-1",
    ITEM_ID,
  );
  assertEquals(probeCalls, 0);
  assertEquals(session.missingTrackCount, 0);
  assertEquals(session.audioTracks.length, 1);
});
