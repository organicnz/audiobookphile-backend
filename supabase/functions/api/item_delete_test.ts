import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deleteLibraryItem } from "../_shared/itemDelete.ts";
import type { StorageDeleteResult } from "../_shared/storage-router.ts";

const ITEM_ID = "11111111-2222-3333-4444-555555555555";
const ACTOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface FakeOptions {
  missing?: boolean;
  rpcError?: string;
  recordError?: string;
  b2Status?: StorageDeleteResult["status"];
  coverListError?: boolean;
  coverRemoveError?: boolean;
}

function manifest() {
  return {
    b2Paths: [
      "b2://library/book/track-01.mp3",
      "b2://library/book/track-02.mp3",
    ],
    supabaseAudioPaths: ["legacy/track-03.mp3"],
    coverPaths: [`${ITEM_ID}/cover.jpg`],
    coverPrefixes: [ITEM_ID],
    retainedFileCount: 4,
  };
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
          return { data: { found: false, item_id: ITEM_ID }, error: null };
        }
        return {
          data: {
            found: true,
            item_id: ITEM_ID,
            audit_id: 42,
            manifest: manifest(),
            retained_file_count: manifest().retainedFileCount,
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
      "audio-files/legacy/track-03.mp3",
      `covers/${ITEM_ID}/cover.jpg`,
    ].sort(),
  );
  assertEquals(calls[0].startsWith("delete_library_item_atomic:"), true);
  assertEquals(
    calls.at(-1)?.startsWith("record_library_item_storage_cleanup:"),
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
  assertEquals(calls.length, 1);
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
