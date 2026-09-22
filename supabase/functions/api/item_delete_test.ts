import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deleteLibraryItem } from "../_shared/itemDelete.ts";

const ITEM_ID = "11111111-2222-3333-4444-555555555555";

function audioFile(ino: string, path: string, duration = 60) {
  return {
    ino,
    duration,
    metadata: { filename: `${ino}.mp3`, path, duration },
  };
}

interface FakeOpts {
  item?: Record<string, unknown> | null;
  failRowDelete?: boolean;
  missingTables?: string[];
  failCoverRemove?: boolean;
  deletedStorage?: string[];
}

/** Fake supabase client: tables are name -> rows; deletes filter by column. */
function fakeDb(opts: FakeOpts = {}): { db: any; calls: string[] } {
  const calls: string[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {
    library_items: opts.item === undefined
      ? [{
        id: ITEM_ID,
        library_id: "lib-1",
        title: "Doomed Book",
        path: "lib-1/Doomed Book",
        cover_path: `${ITEM_ID}/cover.jpg`,
        audio_files: [
          audioFile("a1", `lib-1/Doomed Book/a1.mp3`),
          audioFile("a2", `lib-1/Doomed Book/a2.mp3`),
        ],
        library_files: [{ path: `lib-1/Doomed Book/a1.mp3` }],
      }]
      : (opts.item ? [opts.item] : []),
    media_progress: [{ id: "p1", library_item_id: ITEM_ID }],
    bookmarks: [{ id: "b1", library_item_id: ITEM_ID }],
    user_library_items: [{ user_id: "u1", library_item_id: ITEM_ID }],
    book_authors: [{ library_item_id: ITEM_ID, author_id: "au1" }],
    book_series: [{ library_item_id: ITEM_ID, series_id: "s1" }],
    collection_items: [{ collection_id: "c1", library_item_id: ITEM_ID }],
    playlist_media_items: [{ playlist_id: "pl1", media_item_id: ITEM_ID }],
  };
  const db = {
    from(table: string) {
      const filters: { col: string; val: unknown }[] = [];
      const api = {
        select(_cols: string) {
          return api;
        },
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return api;
        },
        async maybeSingle() {
          calls.push(`${table}.select`);
          if ((opts.missingTables ?? []).includes(table)) {
            return {
              data: null,
              error: { code: "PGRST205", message: "table not found" },
            };
          }
          const rows = (tables[table] ?? []).filter((r) =>
            filters.every((f) => r[f.col] === f.val)
          );
          return { data: rows[0] ?? null, error: null };
        },
        delete() {
          return {
            eq: (col: string, val: unknown) => {
              calls.push(`${table}.delete`);
              if ((opts.missingTables ?? []).includes(table)) {
                return Promise.resolve({
                  error: { code: "PGRST205", message: "table not found" },
                });
              }
              if (table === "library_items" && opts.failRowDelete) {
                return Promise.resolve({
                  error: { message: "violates foreign key" },
                });
              }
              tables[table] = (tables[table] ?? []).filter((r) =>
                r[col] !== val
              );
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return api;
    },
    storage: {
      from(bucket: string) {
        return {
          remove: (paths: string[]) => {
            calls.push(`storage:${bucket}.remove`);
            if (opts.failCoverRemove) {
              return Promise.resolve({ error: { message: "nope" } });
            }
            (opts.deletedStorage ?? []).push(...paths);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  return { db, calls };
}

const ROUTER = {
  deleted: [] as string[],
  fail: new Set<string>(),
  deletePath: async function (p: string) {
    ROUTER.deleted.push(p);
    return !ROUTER.fail.has(p);
  },
};

Deno.test("itemDelete: non-admin is rejected before any write", async () => {
  const { db, calls } = fakeDb();
  const res = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: false,
    hardDelete: true,
    storageRouter: ROUTER,
  });
  assertEquals(res.deleted, false);
  assertEquals(res.status, 403);
  assertEquals(calls.length, 0);
});

Deno.test("itemDelete: malformed id is a 400 with no writes", async () => {
  const { db, calls } = fakeDb();
  const res = await deleteLibraryItem(db, "not-a-uuid", {
    isAdmin: true,
    hardDelete: false,
  });
  assertEquals(res.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("itemDelete: missing item is an idempotent 404", async () => {
  const { db } = fakeDb({ item: null });
  const res = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: false,
  });
  assertEquals(res.deleted, false);
  assertEquals(res.status, 404);
});

Deno.test("itemDelete: soft delete removes dependents + row, keeps files", async () => {
  const { db, calls } = fakeDb();
  const res = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: false,
  });
  assertEquals(res.deleted, true);
  assertEquals(res.status, 200);
  assertEquals(res.removedFiles, 0);
  assertEquals(res.filesRetained, 3); // 2 audio + 1 library_file entries
  assertEquals(res.warnings.length, 0);
  // every dependent table was swept, row last
  for (
    const t of [
      "media_progress",
      "bookmarks",
      "user_library_items",
      "book_authors",
      "book_series",
      "collection_items",
      "playlist_media_items",
    ]
  ) {
    assertEquals(calls.includes(`${t}.delete`), true, t);
  }
  const rowIdx = calls.lastIndexOf("library_items.delete");
  const depIdx = Math.max(
    ...calls.filter((c) => c !== "library_items.delete").map((c) =>
      calls.indexOf(c)
    ),
  );
  assertEquals(rowIdx > depIdx, true);
});

Deno.test("itemDelete: hard delete removes B2 objects + cover", async () => {
  ROUTER.deleted.length = 0;
  ROUTER.fail.clear();
  const removed: string[] = [];
  const { db } = fakeDb({ deletedStorage: removed });
  const res = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: true,
    storageRouter: ROUTER,
  });
  assertEquals(res.deleted, true);
  assertEquals(
    ROUTER.deleted.sort(),
    ["lib-1/Doomed Book/a1.mp3", "lib-1/Doomed Book/a2.mp3"].sort(),
  );
  assertEquals(removed, [`${ITEM_ID}/cover.jpg`]);
  assertEquals(res.removedFiles, 3);
  assertEquals(res.filesRetained, 0);
  assertEquals(res.warnings.length, 0);
});

Deno.test("itemDelete: row-delete failure is a 500, never a throw", async () => {
  const { db } = fakeDb({ failRowDelete: true });
  const res = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: false,
  });
  assertEquals(res.deleted, false);
  assertEquals(res.status, 500);
  assertEquals(typeof res.error, "string");
});

Deno.test("itemDelete: unknown dependent tables are skipped silently", async () => {
  const { db } = fakeDb({
    missingTables: ["bookmarks", "playlist_media_items"],
  });
  const res = await deleteLibraryItem(db, ITEM_ID, {
    isAdmin: true,
    hardDelete: false,
  });
  assertEquals(res.deleted, true);
  assertEquals(res.warnings.length, 0);
});
