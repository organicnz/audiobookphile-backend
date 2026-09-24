import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deleteLibraryItem } from "../_shared/itemDelete.ts";
import type { StorageDeleteResult } from "../_shared/storage-router.ts";

const ITEM_ID = "11111111-2222-3333-4444-555555555555";
const ACTOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface FakeOptions {
  missing?: boolean;
  retry?: boolean;
  completed?: boolean;
  legacyManifest?: boolean;
  invalidCommitted?: boolean;
  unsafePath?: boolean;
  pendingOnFallback?: boolean;
  rpcError?: string;
  malformedRpc?: boolean;
  recordError?: string;
  b2Status?: StorageDeleteResult["status"];
  coverListError?: boolean;
  coverRemoveError?: boolean;
  nestedAudio?: boolean;
}

function manifest() {
  return {
    manifestVersion: 1,
    b2Paths: [
      `b2://${ITEM_ID}/track-01.mp3`,
      `b2://${ITEM_ID}/track-02.mp3`,
    ],
    supabaseAudioPaths: [`${ITEM_ID}/legacy/track-03.mp3`],
    audioPrefixes: [ITEM_ID],
    coverPaths: [`${ITEM_ID}/cover.jpg`],
    coverPrefixes: [ITEM_ID],
    unresolvedStorageCount: 0,
    retainedFileCount: 4,
  };
}

function responseManifest(opts: FakeOptions) {
  if (opts.legacyManifest) {
    return {
      b2Paths: [`b2://${ITEM_ID}/track-01.mp3`],
      supabaseAudioPaths: [],
      coverPaths: [`${ITEM_ID}/cover.jpg`],
      coverPrefixes: [ITEM_ID],
      retainedFileCount: 2,
    };
  }
  if (opts.unsafePath) {
    return { ...manifest(), b2Paths: ["b2://other-item/track.mp3"] };
  }
  return manifest();
}

function fakeDb(
  opts: FakeOptions = {},
): { db: any; calls: string[]; deletedB2: string[]; removed: string[] } {
  const calls: string[] = [];
  const deletedB2: string[] = [];
  const removed: string[] = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      if (name === "delete_library_item_atomic") {
        if (opts.rpcError) {
          return { data: null, error: { message: opts.rpcError } };
        }
        if (opts.missing) {
          return {
            data: { found: false, retry: false, item_id: ITEM_ID },
            error: null,
          };
        }
        if (opts.completed) {
          return {
            data: {
              found: true,
              retry: false,
              item_id: ITEM_ID,
              audit_id: 42,
              manifest: responseManifest(opts),
              storage_cleanup_status: "complete",
              storage_removed_files: 4,
              storage_files_retained: 0,
            },
            error: null,
          };
        }
        if (opts.invalidCommitted) {
          return {
            data: {
              found: true,
              retry: true,
              item_id: "99999999-2222-3333-4444-555555555555",
              audit_id: 42,
              manifest: responseManifest(opts),
            },
            error: null,
          };
        }
        if (opts.retry) {
          return {
            data: {
              found: true,
              retry: true,
              item_id: ITEM_ID,
              audit_id: 42,
              manifest: responseManifest(opts),
              storage_cleanup_status: "pending",
              storage_removed_files: 0,
              storage_files_retained: 0,
            },
            error: null,
          };
        }
        return {
          data: {
            found: true,
            retry: false,
            item_id: ITEM_ID,
            audit_id: 42,
            manifest: opts.malformedRpc ? {} : responseManifest(opts),
            retained_file_count: manifest().retainedFileCount,
            storage_cleanup_status: "pending",
            storage_removed_files: 0,
            storage_files_retained: 0,
          },
          error: null,
        };
      }
      if (name === "get_library_item_delete_cleanup") {
        if (!opts.pendingOnFallback) {
          return {
            data: { found: false, retry: false, item_id: ITEM_ID },
            error: null,
          };
        }
        return {
          data: {
            found: true,
            retry: true,
            item_id: ITEM_ID,
            audit_id: 42,
            manifest: responseManifest(opts),
            storage_cleanup_status: "pending",
            storage_removed_files: 0,
            storage_files_retained: 0,
          },
          error: null,
        };
      }
      if (name === "record_library_item_storage_cleanup") {
        return {
          data: null,
          error: opts.recordError ? { message: opts.recordError } : null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          calls.push(`${bucket}.remove:${paths.join(",")}`);
          if (bucket === "covers" && opts.coverRemoveError) {
            return { error: { message: "cover remove failed" } };
          }
          removed.push(...paths.map((path) => `${bucket}/${path}`));
          return { error: null };
        },
        list: async (prefix: string) => {
          calls.push(`${bucket}.list:${prefix}`);
          if (bucket === "covers" && opts.coverListError) {
            return { data: null, error: { message: "cover list failed" } };
          }
          if (bucket === "audio-files" && opts.nestedAudio) {
            if (prefix === ITEM_ID) {
              return { data: [{ name: "Disc 1", id: null }], error: null };
            }
            if (prefix === `${ITEM_ID}/Disc 1`) {
              return {
                data: [{ name: "track.mp3", id: "nested-file" }],
                error: null,
              };
            }
          }
          return {
            data: bucket === "covers" ? [{ name: "cover.jpg" }] : [],
            error: null,
          };
        },
      }),
    },
  };
  return { db, calls, deletedB2, removed };
}

function router(
  deletedB2: string[],
  status: StorageDeleteResult["status"] = "deleted",
) {
  return {
    deletePathDetailed: async (path: string) => {
      deletedB2.push(path);
      return { status };
    },
  };
}

Deno.test("itemDelete: non-admin is rejected before any RPC", async () => {
  const { db, calls } = fakeDb();
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: false,
    hardDelete: true,
    actorId: ACTOR_ID,
  });
  assertEquals(result.deleted, false);
  assertEquals(result.status, 403);
  assertEquals(calls.length, 0);
});

Deno.test("itemDelete: malformed id is rejected before any RPC", async () => {
  const { db, calls } = fakeDb();
  const result = await deleteLibraryItem(db, "not-a-uuid", {
    isAdmin: true,
    hardDelete: false,
    actorId: ACTOR_ID,
  });
  assertEquals(result.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("itemDelete: missing item is a 404 after the atomic lookup", async () => {
  const { db, calls } = fakeDb({ missing: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: false,
    actorId: ACTOR_ID,
  });
  assertEquals(result.deleted, false);
  assertEquals(result.status, 404);
  assertEquals(
    calls.some((call) => call.startsWith("delete_library_item_atomic:")),
    true,
  );
});

Deno.test("itemDelete: database-only delete is atomic and retains files", async () => {
  const { db, calls } = fakeDb();
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: false,
    actorId: ACTOR_ID,
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "not_requested");
  assertEquals(result.removedFiles, 0);
  assertEquals(result.filesRetained, 4);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].includes('"p_hard_delete":false'), true);
  assertEquals(calls[0].includes(`\"p_actor_id\":\"${ACTOR_ID}\"`), true);
});

Deno.test("itemDelete: hard delete cleans storage after the atomic database delete", async () => {
  const { db, calls, deletedB2, removed } = fakeDb();
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "complete");
  assertEquals(result.removedFiles, 4);
  assertEquals(result.filesRetained, 0);
  assertEquals(deletedB2, manifest().b2Paths);
  assertEquals(
    removed.sort(),
    [
      `audio-files/${ITEM_ID}/legacy/track-03.mp3`,
      `covers/${ITEM_ID}/cover.jpg`,
    ].sort(),
  );
  assertEquals(calls[0].startsWith("delete_library_item_atomic:"), true);
  assertEquals(
    calls.at(-1)?.startsWith("record_library_item_storage_cleanup:"),
    true,
  );
});

Deno.test("itemDelete: nested Supabase audio folders are traversed", async () => {
  const { db, removed } = fakeDb({ nestedAudio: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router([]),
  });
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "complete");
  assertEquals(
    removed.includes(`audio-files/${ITEM_ID}/Disc 1/track.mp3`),
    true,
  );
});

Deno.test("itemDelete: hard delete reports pending storage cleanup truthfully", async () => {
  const { db, calls, deletedB2 } = fakeDb({
    b2Status: "failed",
    coverListError: true,
  });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2, "failed"),
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 202);
  assertEquals(result.storageCleanup, "pending");
  assertEquals(result.filesRetained > 0, true);
  assertEquals(result.warnings.length > 0, true);
  assertEquals(calls.at(-1)?.includes('"p_status":"pending"'), true);
});

Deno.test("itemDelete: atomic database failure never touches storage", async () => {
  const { db, calls, deletedB2 } = fakeDb({
    rpcError: "transaction rolled back",
  });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, false);
  assertEquals(result.status, 500);
  assertEquals(deletedB2.length, 0);
  assertEquals(calls.length, 2);
});

Deno.test("itemDelete: cleanup status failure keeps the delete pending", async () => {
  const { db, deletedB2 } = fakeDb({ recordError: "audit unavailable" });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 202);
  assertEquals(result.storageCleanup, "pending");
  assertEquals(
    result.warnings.includes("storage cleanup status could not be recorded"),
    true,
  );
});

Deno.test("itemDelete: a pending hard delete can retry its stored manifest", async () => {
  const { db, deletedB2, calls } = fakeDb({ retry: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "complete");
  assertEquals(deletedB2, manifest().b2Paths);
  assertEquals(calls[0].includes('"p_hard_delete":true'), true);
  assertEquals(calls.at(-1)?.includes('"p_status":"complete"'), true);
});

Deno.test("itemDelete: fallback lookup recovers a committed delete after RPC transport failure", async () => {
  const { db, deletedB2, calls } = fakeDb({
    rpcError: "connection reset after commit",
    pendingOnFallback: true,
  });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "complete");
  assertEquals(
    calls.some((call) => call.startsWith("get_library_item_delete_cleanup:")),
    true,
  );
});

Deno.test("itemDelete: incomplete committed manifests fail closed as pending", async () => {
  const { db, deletedB2 } = fakeDb({ malformedRpc: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, true);
  assertEquals(result.status, 202);
  assertEquals(result.storageCleanup, "pending");
  assertEquals(
    result.warnings.includes("storage cleanup manifest is incomplete"),
    true,
  );
  assertEquals(deletedB2.length, 0);
});

Deno.test("itemDelete: invalid committed responses are never treated as success", async () => {
  const { db, deletedB2 } = fakeDb({ invalidCommitted: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.deleted, false);
  assertEquals(result.status, 500);
  assertEquals(deletedB2.length, 0);
});

Deno.test("itemDelete: paths outside the item prefix remain pending", async () => {
  const { db, deletedB2 } = fakeDb({ unsafePath: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.status, 202);
  assertEquals(result.storageCleanup, "pending");
  assertEquals(deletedB2.length, 0);
  assertEquals(
    result.warnings.includes(
      "storage manifest contains paths outside the item prefix",
    ),
    true,
  );
});

Deno.test("itemDelete: legacy manifests remain retryable", async () => {
  const { db, deletedB2 } = fakeDb({ legacyManifest: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "complete");
  assertEquals(deletedB2, [`b2://${ITEM_ID}/track-01.mp3`]);
});

Deno.test("itemDelete: completed cleanup retries are idempotent", async () => {
  const { db, calls, deletedB2 } = fakeDb({ completed: true });
  const result = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    actorId: ACTOR_ID,
    storageRouter: router(deletedB2),
  });
  assertEquals(result.status, 200);
  assertEquals(result.storageCleanup, "complete");
  assertEquals(result.removedFiles, 4);
  assertEquals(result.filesRetained, 0);
  assertEquals(deletedB2.length, 0);
  assertEquals(calls.length, 1);
});
