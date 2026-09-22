/**
 * Item Delete — the write path for removing a whole library item (book).
 *
 * Why this exists: the dashboard's "Delete" flow calls
 * DELETE /api/items/:id, but no such route existed — the request fell
 * through to the framework 404, the server action threw an ApiError, and
 * users landed on the "Something went wrong" boundary (and, via the auth
 * refresh chain, sometimes back at the login screen).
 *
 * Safety ordering (mirrors splitApply's crash-safety discipline):
 *   1. Validate (admin, UUID) — cheap rejections first, no writes.
 *   2. Read the item — 404 when already gone (idempotent delete).
 *   3. Delete dependent rows explicitly (merge procs do the same, so no
 *      ON DELETE CASCADE is assumed). Each dependent delete is best-effort:
 *      a missing table is skipped, any other failure is recorded as a
 *      warning — never aborts the delete.
 *   4. hardDelete only: remove B2 audio objects + cover key, best-effort.
 *      Soft delete keeps files on disk so an accidental click is
 *      recoverable from storage; the DB forensic trigger
 *      (audit_library_item_delete_trg) records the row removal either way.
 *   5. Delete the library_items row LAST. Its failure is the only fatal
 *      error (500 JSON — never a throw, so error boundaries stay quiet).
 */

export interface DeleteItemDb {
  from(table: string): any;
  storage: {
    from(bucket: string): {
      remove(paths: string[]): Promise<{ error: unknown }>;
    };
  };
}

export interface DeleteItemOptions {
  isAdmin: boolean;
  hardDelete: boolean;
  /**
   * Real StorageRouter in production (route injects it); absent in unit
   * tests, where storage deletes are reported as warnings instead of
   * silently claimed.
   */
  storageRouter?: { deletePath(path: string): Promise<boolean> };
}

export interface DeleteItemResult {
  deleted: boolean;
  /** HTTP status the route adapter should answer with. */
  status: 200 | 400 | 403 | 404 | 500;
  error?: string;
  deletedId?: string;
  removedFiles: number;
  filesRetained: number;
  warnings: string[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** library_item_id-keyed tables touched by delete (merge procs agree). */
const DEPENDENT_TABLES = [
  "media_progress",
  "bookmarks",
  "user_library_items",
  "book_authors",
  "book_series",
  "collection_items",
] as const;

/** Junctions whose item column is NOT library_item_id. */
const ALIASED_DEPENDENTS = [
  { table: "playlist_media_items", column: "media_item_id" },
] as const;

function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === "PGRST205" || code === "42P01") return true;
  const msg = String(
    (err as { message?: unknown })?.message ?? err ?? "",
  ).toLowerCase();
  return msg.includes("does not exist") || msg.includes("not found") ||
    // Table-not-found surfaces through PostgREST wording too.
    msg.includes("relation") && msg.includes("does not exist");
}

function storagePathOf(entry: unknown): string {
  const e = (entry ?? {}) as Record<string, unknown>;
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  for (
    const cand of [md.path, e.storage_path, e.path, md.storagePath]
  ) {
    const s = String(cand ?? "").trim();
    // B2 object keys only: skip legacy supabase:// URIs and http(s) URLs —
    // StorageRouter.deletePath only understands B2 tiers, and the covers
    // bucket is handled separately.
    if (
      s && !s.startsWith("supabase://") && !s.startsWith("http") &&
      !s.startsWith("/")
    ) return s;
  }
  return "";
}

export function looksLikeCoverKey(coverPath: unknown): coverPath is string {
  const s = String(coverPath ?? "").trim();
  return !!s && s !== "missing" && !s.startsWith("/") &&
    !s.startsWith("http") && !s.startsWith("supabase://");
}

export async function deleteLibraryItem(
  db: DeleteItemDb,
  itemId: string,
  opts: DeleteItemOptions,
): Promise<DeleteItemResult> {
  const warnings: string[] = [];
  const fail = (
    status: 400 | 403 | 404 | 500,
    error: string,
  ): DeleteItemResult => ({
    deleted: false,
    status,
    error,
    removedFiles: 0,
    filesRetained: 0,
    warnings,
  });

  if (!opts.isAdmin) {
    return fail(403, "Forbidden: Admin access required");
  }
  if (!UUID_RE.test(String(itemId ?? ""))) {
    return fail(400, "Invalid item id");
  }

  let item: Record<string, unknown> | null = null;
  try {
    const { data, error } = await db.from("library_items").select(
      "id, library_id, title, path, cover_path, audio_files, library_files",
    ).eq("id", itemId).maybeSingle();
    if (error) {
      return fail(
        500,
        `Failed to load item: ${
          (error as { message?: string })?.message ?? String(error)
        }`,
      );
    }
    item = (data ?? null) as Record<string, unknown> | null;
  } catch (err) {
    return fail(
      500,
      `Failed to load item: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!item) return fail(404, "Item not found");

  const audioFiles = Array.isArray(item.audio_files) ? item.audio_files : [];
  const libraryFiles = Array.isArray(item.library_files)
    ? item.library_files
    : [];

  // 3. Dependents first — the row delete must never hit an FK wall.
  for (const table of DEPENDENT_TABLES) {
    try {
      const { error } = await db.from(table).delete().eq(
        "library_item_id",
        itemId,
      );
      if (error && !isMissingTable(error)) {
        warnings.push(
          `${table}: ${
            (error as { message?: string })?.message ?? String(error)
          }`,
        );
      }
    } catch (err) {
      warnings.push(
        `${table}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const { table, column } of ALIASED_DEPENDENTS) {
    try {
      const { error } = await db.from(table).delete().eq(column, itemId);
      if (error && !isMissingTable(error)) {
        warnings.push(
          `${table}: ${
            (error as { message?: string })?.message ?? String(error)
          }`,
        );
      }
    } catch (err) {
      warnings.push(
        `${table}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Storage — hardDelete only, best-effort, counted.
  let removedFiles = 0;
  let filesRetained = 0;
  if (opts.hardDelete) {
    const paths = new Set<string>();
    for (const f of [...audioFiles, ...libraryFiles]) {
      const p = storagePathOf(f);
      if (p) paths.add(p);
    }
    filesRetained = 0; // recomputed below: attempted minus removed
    const router = opts.storageRouter;
    for (const p of paths) {
      if (!router) {
        warnings.push(`storage: skipped ${p} (no router)`);
        continue;
      }
      try {
        const ok = await router.deletePath(p);
        if (ok) removedFiles++;
        else warnings.push(`storage: no tier held ${p}`);
      } catch (err) {
        warnings.push(
          `storage ${p}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    filesRetained = paths.size - removedFiles;
    if (looksLikeCoverKey(item.cover_path)) {
      try {
        const { error } = await db.storage.from("covers").remove([
          String(item.cover_path),
        ]);
        if (error) {
          warnings.push(
            `covers: ${
              (error as { message?: string })?.message ?? String(error)
            }`,
          );
        } else removedFiles++;
      } catch (err) {
        warnings.push(
          `covers: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    filesRetained = audioFiles.length + libraryFiles.length;
  }

  // 5. The row itself, last. The DB trigger audit_library_item_delete_trg
  // records (item_id, title, path, media_id, audio_count) automatically.
  try {
    const { error } = await db.from("library_items").delete().eq(
      "id",
      itemId,
    );
    if (error) {
      return {
        deleted: false,
        status: 500,
        error: `Failed to delete item: ${
          (error as { message?: string })?.message ?? String(error)
        }`,
        removedFiles,
        filesRetained,
        warnings,
      };
    }
  } catch (err) {
    return {
      deleted: false,
      status: 500,
      error: `Failed to delete item: ${
        err instanceof Error ? err.message : String(err)
      }`,
      removedFiles,
      filesRetained,
      warnings,
    };
  }

  return {
    deleted: true,
    status: 200,
    deletedId: itemId,
    removedFiles,
    filesRetained,
    warnings,
  };
}
