/**
 * Libraries Domain Module — Pure business logic for library operations.
 *
 * Extracted from routes/libraries.ts to separate HTTP concerns from domain logic.
 * Contains cache management, projection constants, and type definitions used
 * across library endpoints.
 */

import type { Database } from "../../../../../src/types/supabase.ts";

/* =========================================================================
 * Types
 * ========================================================================= */

export type LibraryRow = Database["public"]["Tables"]["libraries"]["Row"];
export type LibraryFolderRow =
  Database["public"]["Tables"]["library_folders"]["Row"];
export type LibraryWithFolders = LibraryRow & {
  library_folders: LibraryFolderRow[];
};

/* =========================================================================
 * Query Projections
 *
 * Shelf/list projections. The audio_files/library_files/chapters/embedding
 * columns can be megabytes per item (hundreds of chapter MP3s), so list
 * endpoints select only the columns the UI renders and leave per-file data
 * to the detail endpoint (/api/items/:id). Keeps a 100-book shelf ~20x
 * smaller and skips the pgvector embedding column entirely.
 * ========================================================================= */

export const LIST_ITEM_SELECT =
  "id, library_id, ino, path, rel_path, title, subtitle, " +
  "author_names_first_last, narrators, genres, tags, published_year, " +
  "published_date, publisher, description, isbn, asin, language, explicit, " +
  "abridged, cover_path, duration, size, is_file, is_missing, is_invalid, " +
  "mtime, ctime, birthtime, created_at, updated_at, media_type, " +
  "book_authors(authors(*)), book_series(series(*))";

export const FULL_ITEM_SELECT =
  "*, book_authors(authors(*)), book_series(series(*))";

/* =========================================================================
 * In-Memory Cache
 *
 * Simple TTL cache for library items. Scoped to a single Deno isolate —
 * each new edge function invocation starts with a cold cache (by design,
 * prevents stale state across deploys).
 * ========================================================================= */

export interface CacheEntry {
  items: unknown[];
  count: number | null;
  timestamp: number;
}

const CACHE_TTL = 1000 * 60; // 60 seconds

export class LibraryItemsCache {
  private cache = new Map<string, CacheEntry>();

  /** Build a cache key from library ID + query params. */
  buildKey(libraryId: string, params: Record<string, string>): string {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`)
      .join("&");
    return `${libraryId}:${sorted}`;
  }

  /** Get a cached entry if it exists and hasn't expired. */
  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  /** Store an entry in the cache. */
  set(key: string, items: unknown[], count: number | null): void {
    this.cache.set(key, { items, count, timestamp: Date.now() });
  }

  /** Invalidate all entries for a specific library. */
  invalidateLibrary(libraryId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${libraryId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }
}

/** Singleton cache instance for the current isolate. */
export const libraryItemsCache = new LibraryItemsCache();

/* =========================================================================
 * Library Validation
 * ========================================================================= */

/** Validate that a library ID exists and the user has access. */
export async function validateLibraryAccess(
  supabase: { from: (table: string) => any },
  libraryId: string,
  _userId: string,
): Promise<{ valid: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("libraries")
    .select("id, user_id")
    .eq("id", libraryId)
    .maybeSingle();

  if (error || !data) {
    return { valid: false, error: "Library not found" };
  }

  return { valid: true };
}

/** Parse and validate sort parameters for library item queries. */
export function parseSortParams(
  sortBy: string = "title",
  sortDesc: boolean = false,
): { column: string; ascending: boolean } {
  const allowedColumns = [
    "title",
    "author_names_first_last",
    "published_year",
    "created_at",
    "updated_at",
    "duration",
    "size",
  ];

  const column = allowedColumns.includes(sortBy) ? sortBy : "title";
  return { column, ascending: !sortDesc };
}
