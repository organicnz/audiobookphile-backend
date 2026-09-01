import {
  LibraryItemWithBooks,
  mapBookForMobile,
  mapLibraryForMobile,
} from "../../api/mappers.ts";
import { Database } from "../../../../src/types/supabase.ts";
import { requireAdminRole } from "../_shared/auth.ts";
import { smartSortLibraryItems } from "../../_shared/zai.ts";
import { createOpenApiRouter, SuccessSchema, z } from "../_shared/openapi.ts";
import { assertStorageQuota } from "../../_shared/storage-quota.ts";

export const librariesRouter = createOpenApiRouter();

interface CacheEntry {
  items: any[];
  count: number | null;
  timestamp: number;
}
const itemsCache = new Map<string, CacheEntry>();
const CACHE_TTL = 1000 * 60; // 60 seconds

// Shelf/list projections. The audio_files/library_files/chapters/embedding
// columns can be megabytes per item (hundreds of chapter MP3s), so list
// endpoints select only the columns the UI renders and leave per-file data
// to the detail endpoint (/api/items/:id). Keeps a 100-book shelf ~20x
// smaller and skips the pgvector embedding column entirely.
const LIST_ITEM_SELECT =
  "id, library_id, ino, path, rel_path, title, subtitle, " +
  "author_names_first_last, narrators, genres, tags, published_year, " +
  "published_date, publisher, description, isbn, asin, language, explicit, " +
  "abridged, cover_path, duration, size, is_file, is_missing, is_invalid, " +
  "mtime, ctime, birthtime, created_at, updated_at, media_type, " +
  "book_authors(authors(*)), book_series(series(*))";
const FULL_ITEM_SELECT = "*, book_authors(authors(*)), book_series(series(*))";

type LibraryWithFolders = Database["public"]["Tables"]["libraries"]["Row"] & {
  library_folders: Database["public"]["Tables"]["library_folders"]["Row"][];
};

// =========================
// OpenAPI Schemas & Route Definitions
// =========================

// Library/book payloads are deep, evolving shapes produced by the shared
// mappers — passthrough keeps the spec honest without pinning every field.
const EntitySchema = z.object({ id: z.string() }).passthrough();
const LibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  folders: z.array(
    z.object({
      id: z.string(),
      fullPath: z.string().nullish(),
      libraryId: z.string().nullish(),
      addedAt: z.number().nullish(),
    }),
  ).nullish(),
  displayOrder: z.number().nullish(),
  icon: z.string().nullish(),
  mediaType: z.string().nullish(),
  provider: z.string().nullish(),
  settings: z.object({
    coverAspectRatio: z.number().nullish(),
    disableWatcher: z.boolean().nullish(),
    skipMatchingMediaWithAsin: z.boolean().nullish(),
    skipMatchingMediaWithIsbn: z.boolean().nullish(),
    autoScanCronExpression: z.string().nullish(),
  }).nullish(),
  createdAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
  lastUpdate: z.number().nullish(),
});
const ServerErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  stack: z.string().optional(),
  details: z.array(z.any()).optional(),
  hint: z.string().optional(),
});
const ForbiddenSchema = z.object({ error: z.string() });
const PaginatedResponse = z.object({
  results: z.array(EntitySchema),
  total: z.number(),
  limit: z.number(),
  page: z.number(),
  sortBy: z.string(),
  sortDesc: z.boolean(),
});

/** Library create body — partial so the admin gate (403) fires before body validation (400). */
const LibraryCreateBodySchema = z.object({
  name: z.string().optional(),
  mediaType: z.string().optional(),
  provider: z.string().optional(),
  folders: z.array(z.object({ fullPath: z.string() })).optional(),
});

const libraryListRoute = {
  method: "get" as const,
  path: "/",
  tags: ["libraries"],
  responses: {
    200: {
      description: "Libraries visible to the authenticated user",
      content: {
        "application/json": {
          schema: z.object({ libraries: z.array(LibrarySchema) }),
        },
      },
    },
  },
};

const libraryCreateRoute = {
  method: "post" as const,
  path: "/",
  tags: ["libraries"],
  request: {
    body: {
      content: {
        "application/json": { schema: LibraryCreateBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Created library",
      content: {
        "application/json": { schema: LibrarySchema },
      },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: ForbiddenSchema },
      },
    },
  },
};

const libraryUpdateRoute = {
  method: "patch" as const,
  path: "/:id",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            displayOrder: z.number().optional(),
            folders: z.array(z.record(z.unknown())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated library",
      content: {
        "application/json": { schema: LibrarySchema },
      },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: ForbiddenSchema },
      },
    },
  },
};

const libraryDeleteRoute = {
  method: "delete" as const,
  path: "/:id",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Library deleted",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: ForbiddenSchema },
      },
    },
  },
};

const libraryItemsRoute = {
  method: "get" as const,
  path: "/:id/items",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Paginated shelf of library items",
      content: {
        "application/json": { schema: PaginatedResponse },
      },
    },
    500: {
      description: "Query failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

const smartSortRoute = {
  method: "post" as const,
  path: "/:id/smart-sort",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ criteria: z.string().optional() }).partial(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "AI-sorted library item ids",
      content: {
        "application/json": {
          schema: z.object({
            sortedIds: z.array(z.string()),
            provider: z.string().optional(),
          }),
        },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: ForbiddenSchema },
      },
    },
  },
};

const librarySearchRoute = {
  method: "get" as const,
  path: "/:id/search",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Search results across items, authors, series and facets",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(z.unknown()),
            book: z.array(z.unknown()),
            podcast: z.array(z.unknown()),
            authors: z.array(z.unknown()),
            series: z.array(z.unknown()),
            tags: z.array(z.unknown()),
            genres: z.array(z.unknown()),
            narrators: z.array(z.unknown()),
            episodes: z.array(z.unknown()),
          }),
        },
      },
    },
  },
};

const filterDataRoute = {
  method: "get" as const,
  path: "/:id/filterdata",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Empty facet skeleton",
      content: {
        "application/json": {
          schema: z.object({
            authors: z.array(z.unknown()),
            genres: z.array(z.unknown()),
            tags: z.array(z.unknown()),
            series: z.array(z.unknown()),
            narrators: z.array(z.unknown()),
            languages: z.array(z.unknown()),
          }),
        },
      },
    },
  },
};

const matchAllRoute = {
  method: "get" as const,
  path: "/:id/matchall",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    202: {
      description: "Metadata match kicked off in the background",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
  },
};

const scanRoute = {
  method: "post" as const,
  path: "/:id/scan",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Scan status",
      content: {
        "application/json": {
          schema: z.object({ result: z.string() }),
        },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: ForbiddenSchema },
      },
    },
  },
};

const seriesRoute = {
  method: "get" as const,
  path: "/:id/series",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Paginated series",
      content: {
        "application/json": { schema: PaginatedResponse },
      },
    },
    500: {
      description: "Query failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

const authorsRoute = {
  method: "get" as const,
  path: "/:id/authors",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Paginated authors",
      content: {
        "application/json": {
          schema: z.object({
            authors: z.array(EntitySchema),
            total: z.number(),
            limit: z.number(),
            page: z.number(),
            sortBy: z.string(),
            sortDesc: z.boolean(),
          }),
        },
      },
    },
    500: {
      description: "Query failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

const collectionsRoute = {
  method: "get" as const,
  path: "/:id/collections",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Paginated collections",
      content: {
        "application/json": { schema: PaginatedResponse },
      },
    },
    500: {
      description: "Query failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

const playlistsRoute = {
  method: "get" as const,
  path: "/:id/playlists",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Paginated playlists",
      content: {
        "application/json": { schema: PaginatedResponse },
      },
    },
    500: {
      description: "Query failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

const personalizedRoute = {
  method: "get" as const,
  path: "/:id/personalized",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Shelves for this library",
      content: {
        "application/json": {
          schema: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              labelStringKey: z.string(),
              type: z.string(),
              entities: z.array(z.unknown()),
              total: z.number(),
            }),
          ),
        },
      },
    },
  },
};

const statsRoute = {
  method: "get" as const,
  path: "/:id/stats",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Library statistics",
      content: {
        "application/json": { schema: z.record(z.any()) },
      },
    },
    500: {
      description: "Query failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

const narratorsRoute = {
  method: "get" as const,
  path: "/:id/narrators",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Narrators in this library",
      content: {
        "application/json": {
          schema: z.object({ narrators: z.array(z.unknown()) }),
        },
      },
    },
  },
};

const deduplicateRoute = {
  method: "post" as const,
  path: "/:id/deduplicate",
  tags: ["libraries"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Deduplication result",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            removedCount: z.number(),
          }),
        },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: ForbiddenSchema },
      },
    },
    500: {
      description: "Deduplication failure",
      content: {
        "application/json": { schema: ServerErrorSchema },
      },
    },
  },
};

// =========================
// Route Handlers
// =========================

librariesRouter.openapi(libraryListRoute, async (c) => {
  const supabase = c.get("supabase");
  const { data: libraries, error } = await supabase.from("libraries").select(
    "*, library_folders(*)",
  ).order("display_order");
  if (error) throw error;
  const formatted = libraries.map((l) =>
    mapLibraryForMobile(l as unknown as LibraryWithFolders)
  );
  c.header(
    "Cache-Control",
    "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
  );
  return c.json({ libraries: formatted });
});

librariesRouter.openapi(libraryCreateRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const rawBody = await c.req.json();
  const LibraryCreatePayload = z.object({
    name: z.string(),
    mediaType: z.string().optional(),
    provider: z.string().optional(),
    folders: z.array(z.object({ fullPath: z.string() })).optional(),
  });

  const parsed = LibraryCreatePayload.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", details: parsed.error.issues },
      400,
    );
  }
  const body = parsed.data;

  const { data: libraries } = await supabase.from("libraries").select("id");
  const display_order = libraries ? libraries.length + 1 : 1;

  const { data, error } = await supabase
    .from("libraries")
    .insert({
      id: crypto.randomUUID(),
      name: body.name,
      media_type: body.mediaType,
      provider: body.provider || "default",
      display_order,
    })
    .select()
    .single();

  if (error) throw error;

  if (body.folders && body.folders.length > 0) {
    const folders = body.folders.map((f: Record<string, unknown>) => ({
      id: String(f.id || crypto.randomUUID()),
      library_id: data.id,
      path: String(f.fullPath || f.path || ""),
    }));
    await supabase.from("library_folders").insert(folders);
  }

  const { data: fullLibrary } = await supabase.from("libraries").select(
    "*, library_folders(*)",
  ).eq("id", data.id).single();
  return c.json(
    mapLibraryForMobile((fullLibrary || {}) as unknown as LibraryWithFolders),
    200,
  );
});

librariesRouter.openapi(libraryUpdateRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const rawBody = await c.req.json();

  const LibraryUpdatePayload = z.object({
    name: z.string().optional(),
    displayOrder: z.number().optional(),
    folders: z.array(
      z.object({ fullPath: z.string().optional(), id: z.string().optional() }),
    ).optional(),
  });

  const parsed = LibraryUpdatePayload.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", details: parsed.error.issues },
      400,
    );
  }
  const body = parsed.data;

  const updates: Database["public"]["Tables"]["libraries"]["Update"] = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.displayOrder !== undefined) {
    updates.display_order = body.displayOrder;
  }
  // etc

  const { error } = await supabase.from("libraries").update(updates).eq(
    "id",
    libraryId,
  );
  if (error) throw error;

  if (body.folders) {
    await supabase.from("library_folders").delete().eq("library_id", libraryId);
    if (body.folders.length > 0) {
      const folders = body.folders.map((f: Record<string, unknown>) => ({
        id: String(f.id || crypto.randomUUID()),
        library_id: libraryId,
        path: String(f.fullPath || f.path || f.id),
      }));
      await supabase.from("library_folders").insert(folders);
    }
  }

  const { data: fullLibrary } = await supabase.from("libraries").select(
    "*, library_folders(*)",
  ).eq("id", libraryId).single();
  return c.json(
    mapLibraryForMobile((fullLibrary || {}) as unknown as LibraryWithFolders),
    200,
  );
});

librariesRouter.openapi(libraryDeleteRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const { error } = await supabase.from("libraries").delete().eq(
    "id",
    libraryId,
  );
  if (error) throw error;
  return c.json({ success: true }, 200);
});

librariesRouter.openapi(libraryItemsRoute, async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");

  const queryParams = new URL(c.req.raw.url).searchParams;
  const rawLimit = queryParams.get("limit");
  const parsedLimit = rawLimit !== null ? parseInt(rawLimit, 10) : 0;
  const limit = parsedLimit <= 0 ? 0 : parsedLimit;
  const page = parseInt(queryParams.get("page") || "0", 10);
  const sortParam = (queryParams.get("sort") || "addedAt").toLowerCase();
  const isDesc = queryParams.get("desc") === "1" ||
    queryParams.get("desc") === "true";
  const isFetchAll = limit === 0;
  const offset = isFetchAll ? 0 : page * limit;

  let dbSortField = "created_at";
  if (sortParam.includes("author")) {
    dbSortField = "author_names_first_last";
  } else if (sortParam.includes("title") || sortParam.includes("name")) {
    dbSortField = "title";
  } else if (sortParam.includes("pub") || sortParam.includes("year")) {
    dbSortField = "published_year";
  } else if (sortParam.includes("update")) {
    dbSortField = "updated_at";
  } else if (sortParam.includes("duration")) {
    dbSortField = "duration";
  } else if (sortParam.includes("size")) {
    dbSortField = "size";
  } else {
    dbSortField = "created_at";
  }

  const search = (queryParams.get("q") || queryParams.get("search") || "")
    .trim();
  const authorId = queryParams.get("authorId");
  const seriesId = queryParams.get("seriesId");
  // List mode (default): slim shelf payloads (no per-file track data). The
  // detail endpoint /api/items/:id always returns the full book.
  const includeFiles =
    queryParams.get("include")?.split(",").includes("files") === true;
  const itemSelect = includeFiles ? FULL_ITEM_SELECT : LIST_ITEM_SELECT;

  try {
    const cacheKey =
      `${libraryId}-${dbSortField}-${isDesc}-${limit}-${page}-${search}-${authorId}-${seriesId}-${
        includeFiles ? "f" : "l"
      }`;
    let items: any[] = [];
    let count: number | null = 0;
    const now = Date.now();
    const cached = itemsCache.get(cacheKey);

    if (cached && now - cached.timestamp < CACHE_TTL) {
      items = cached.items;
      count = cached.count;
    } else {
      if (isFetchAll) {
        const CHUNK_SIZE = 500;
        let currentOffset = 0;
        while (true) {
          let batchQuery = supabase
            .from("library_items")
            .select(itemSelect, {
              count: "exact",
            })
            .eq("library_id", libraryId);

          if (search) {
            batchQuery = batchQuery.or(
              `title.ilike.%${search}%,author_names_first_last.ilike.%${search}%,description.ilike.%${search}%,narrator_names.ilike.%${search}%,subtitle.ilike.%${search}%,publisher.ilike.%${search}%`,
            );
          }
          if (authorId) {
            batchQuery = batchQuery.eq("book_authors.author_id", authorId);
          }
          if (seriesId) {
            batchQuery = batchQuery.eq("book_series.series_id", seriesId);
          }

          batchQuery = batchQuery.order(dbSortField, { ascending: !isDesc })
            .range(currentOffset, currentOffset + CHUNK_SIZE - 1);

          const { data, error, count: totalCount } =
            (await batchQuery) as unknown as {
              data: any[] | null;
              error: any;
              count: number | null;
            };

          if (error) {
            return c.json(
              {
                error: error.message || error,
                details: error.details,
                hint: error.hint,
              },
              500,
            );
          }

          count = totalCount;
          if (!data || data.length === 0) break;

          items.push(...data);
          if (
            data.length < CHUNK_SIZE ||
            (count !== null && items.length >= count)
          ) {
            break;
          }
          currentOffset += CHUNK_SIZE;
        }
      } else {
        let query = supabase
          .from("library_items")
          .select(itemSelect, {
            count: "exact",
          })
          .eq("library_id", libraryId);

        if (search) {
          query = query.or(
            `title.ilike.%${search}%,author_names_first_last.ilike.%${search}%,description.ilike.%${search}%,narrator_names.ilike.%${search}%,subtitle.ilike.%${search}%,publisher.ilike.%${search}%`,
          );
        }
        if (authorId) {
          query = query.eq("book_authors.author_id", authorId);
        }
        if (seriesId) {
          query = query.eq("book_series.series_id", seriesId);
        }

        query = query.order(dbSortField, { ascending: !isDesc }).range(
          offset,
          offset + limit - 1,
        );

        const { data, error, count: totalCount } = (await query) as unknown as {
          data: any[] | null;
          error: any;
          count: number | null;
        };

        if (error) {
          return c.json(
            {
              error: error.message || error,
              details: error.details,
              hint: error.hint,
            },
            500,
          );
        }

        items = data || [];
        count = totalCount;
      }

      // Save to cache
      itemsCache.set(cacheKey, { items, count, timestamp: now });
    }

    // Natural in-memory sort refinement for title & author
    if (items && items.length > 1) {
      items.sort((a, b) => {
        let valA = "";
        let valB = "";

        if (dbSortField === "author_names_first_last") {
          valA = a.author_names_first_last || "";
          valB = b.author_names_first_last || "";
        } else if (dbSortField === "title") {
          valA = (a.title || "").replace(/^(the|a|an)\s+/i, "");
          valB = (b.title || "").replace(/^(the|a|an)\s+/i, "");
        } else {
          return 0;
        }

        const comp = valA.localeCompare(valB, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        return isDesc ? -comp : comp;
      });
    }

    const itemIds = items.map((i) => i.id);
    let progressMap = new Map();
    if (itemIds.length > 0) {
      const { data: progressData } = await supabase
        .from("media_progress")
        .select("*")
        .eq("user_id", user.id)
        .in("library_item_id", itemIds)
        .is("episode_id", null);
      progressMap = new Map(
        (progressData || []).map((p) => [p.library_item_id, p]),
      );
    }

    const mappedItems = items.map((i) =>
      mapBookForMobile(
        i as unknown as LibraryItemWithBooks,
        progressMap.get(i.id),
        { includeFiles },
      )
    );

    const safeLimit = limit > 0 ? limit : 0;
    const safePage = limit > 0 ? Math.floor(offset / limit) : page;

    const response = {
      results: mappedItems,
      total: count || 0,
      limit: safeLimit,
      page: safePage,
      sortBy: sortParam,
      sortDesc: isDesc,
    };

    // Non-blocking background auto-deduplication via database RPC
    const runAutoDeduplicate = async () => {
      try {
        await (supabase as any).rpc("deduplicate_library_items");
      } catch (_e) {
        // Silent background cleanup
      }
    };

    // @ts-ignore
    if (
      typeof (globalThis as any).EdgeRuntime !== "undefined" &&
      typeof (globalThis as any).EdgeRuntime.waitUntil === "function"
    ) {
      // @ts-ignore
      (globalThis as any).EdgeRuntime.waitUntil(runAutoDeduplicate());
    } else {
      runAutoDeduplicate().catch(() => {});
    }

    c.header(
      "Cache-Control",
      "private, max-age=30, stale-while-revalidate=300",
    );
    return c.json(response, 200);
  } catch (e: unknown) {
    const err = e as Error;
    return c.json(
      {
        error: "Exception",
        message: err.message,
        stack: err.stack,
      },
      500,
    );
  }
});

librariesRouter.openapi(smartSortRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const body = await c.req.json().catch(() => ({}));
  const criteria = body.criteria || "chronological reading order";

  const { data: items, error } = await supabase.from("library_items").select(
    "id, title, author_names_first_last, published_year",
  ).eq("library_id", libraryId);

  if (error || !items || items.length === 0) {
    return c.json({ sortedIds: [] }, 200);
  }

  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";

  const sortedIds = await smartSortLibraryItems(items, criteria, zaiApiKey);
  return c.json(
    { sortedIds, provider: zaiApiKey ? "z.ai-glm-4" : "local" },
    200,
  );
});

function sanitizeSearchToken(input: string): string {
  return input.replace(/[,():%.*]/g, "").trim();
}

librariesRouter.openapi(librarySearchRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const qParam = new URL(c.req.raw.url).searchParams.get("q") || "";
  const queryText = qParam.trim();
  const limit = parseInt(
    new URL(c.req.raw.url).searchParams.get("limit") || "12",
    10,
  );

  if (!queryText) {
    return c.json({
      results: [],
      book: [],
      podcast: [],
      authors: [],
      series: [],
      tags: [],
      genres: [],
      narrators: [],
      episodes: [],
    });
  }

  // 1. Fetch library items across all searchable fields using sanitized tokenized multi-word matching
  const tokens = queryText
    .split(/\s+/)
    .map(sanitizeSearchToken)
    .filter((t) => t.length > 0);

  let itemsQuery = supabase.from("library_items").select(
    LIST_ITEM_SELECT,
  ).eq("library_id", libraryId);

  for (const token of tokens) {
    itemsQuery = itemsQuery.or(
      `title.ilike.%${token}%,author_names_first_last.ilike.%${token}%,description.ilike.%${token}%,subtitle.ilike.%${token}%,publisher.ilike.%${token}%`,
    );
  }

  let { data: items, error: itemsError } =
    (await itemsQuery.limit(limit * 2)) as unknown as {
      data: any[] | null;
      error: any;
    };

  const cleanQueryText = sanitizeSearchToken(queryText);
  if ((!items || items.length === 0) && cleanQueryText) {
    const fallbackRes = (await supabase
      .from("library_items")
      .select(LIST_ITEM_SELECT)
      .eq("library_id", libraryId)
      .or(
        `title.ilike.%${cleanQueryText}%,author_names_first_last.ilike.%${cleanQueryText}%,description.ilike.%${cleanQueryText}%,subtitle.ilike.%${cleanQueryText}%,publisher.ilike.%${cleanQueryText}%`,
      )
      .limit(limit * 2)) as unknown as { data: any[] | null };
    if (fallbackRes.data) items = fallbackRes.data;
  }

  if (itemsError) throw itemsError;

  const user = c.get("user");
  const itemIds = (items || []).map((i) => i.id);
  let progressMap = new Map();
  if (user && itemIds.length > 0) {
    const { data: progressData } = await supabase
      .from("media_progress")
      .select("*")
      .eq("user_id", user.id)
      .in("library_item_id", itemIds)
      .is("episode_id", null);
    progressMap = new Map(
      (progressData || []).map((p) => [p.library_item_id, p]),
    );
  }

  const qLower = queryText.toLowerCase();

  const formattedItems = (items || []).map((item) => {
    const mapped = mapBookForMobile(
      item as unknown as LibraryItemWithBooks,
      progressMap.get(item.id),
      { includeFiles: false },
    );

    let matchKey = "title";
    let matchText = item.title || "";

    const narratorsStr = Array.isArray(item.narrators)
      ? item.narrators.join(", ")
      : typeof item.narrators === "string"
      ? item.narrators
      : "";

    if (item.title && item.title.toLowerCase().includes(qLower)) {
      matchKey = "title";
      matchText = item.title;
    } else if (
      item.author_names_first_last &&
      item.author_names_first_last.toLowerCase().includes(qLower)
    ) {
      matchKey = "authorName";
      matchText = item.author_names_first_last;
    } else if (narratorsStr && narratorsStr.toLowerCase().includes(qLower)) {
      matchKey = "narratorName";
      matchText = narratorsStr;
    } else if (
      item.description && item.description.toLowerCase().includes(qLower)
    ) {
      matchKey = "description";
      matchText = item.description;
    }

    return {
      libraryItem: mapped,
      matchKey,
      matchText,
    };
  });

  const bookResults = formattedItems.filter((i) =>
    i.libraryItem.mediaType !== "podcast"
  ).slice(0, limit);
  const podcastResults = formattedItems.filter((i) =>
    i.libraryItem.mediaType === "podcast"
  ).slice(0, limit);

  const searchPattern = cleanQueryText || queryText;

  // 2. Query matching authors
  const { data: authorsData } = await supabase
    .from("authors")
    .select("*, book_authors(library_item_id)")
    .eq("library_id", libraryId)
    .ilike("name", `%${searchPattern}%`)
    .limit(limit);

  const authorResults = (authorsData || []).map((a) => ({
    id: a.id,
    name: a.name,
    asin: a.asin || null,
    description: a.description || null,
    imagePath: a.image_path || null,
    libraryId: a.library_id,
    addedAt: new Date(a.created_at).getTime(),
    updatedAt: new Date(a.updated_at || a.created_at).getTime(),
    numBooks: Array.isArray(a.book_authors) ? a.book_authors.length : 0,
  }));

  // 3. Query matching series
  const { data: seriesData } = await supabase
    .from("series")
    .select(
      "*, book_series(sequence, library_items(id, title, cover_path, duration, updated_at, created_at))",
    )
    .eq("library_id", libraryId)
    .ilike("name", `%${searchPattern}%`)
    .limit(limit);

  const seriesResults = (seriesData || []).map((s) => {
    const books = (s.book_series || []).map((bs: any) => {
      const book = Array.isArray(bs.library_items)
        ? bs.library_items[0]
        : bs.library_items;
      return {
        id: book?.id || bs.library_item_id,
        sequence: bs.sequence,
        title: book?.title || "",
        addedAt: book?.created_at
          ? new Date(book.created_at).getTime()
          : undefined,
        updatedAt: book?.updated_at
          ? new Date(book.updated_at).getTime()
          : undefined,
        media: {
          id: book?.id,
          coverPath: book?.cover_path || null,
          duration: Number(book?.duration) || undefined,
        },
        cover: book?.cover_path || null,
      };
    });

    return {
      series: {
        id: s.id,
        name: s.name,
        nameIgnorePrefix: s.name_ignore_prefix || s.name,
        description: s.description || null,
        libraryId: s.library_id,
        addedAt: new Date(s.created_at).getTime(),
        updatedAt: new Date(s.updated_at || s.created_at).getTime(),
        books,
        numBooks: books.length,
      },
      books,
    };
  });

  // 4. Tags, Genres, Narrators aggregation from library items
  const tagsMap = new Map<string, number>();
  const genresMap = new Map<string, number>();
  const narratorsMap = new Map<string, number>();
  (items || []).forEach((item) => {
    if (Array.isArray(item.tags)) {
      (item.tags as unknown[]).forEach((t) => {
        const tag = typeof t === "string" ? t : "";
        if (tag && tag.toLowerCase().includes(qLower)) {
          tagsMap.set(tag, (tagsMap.get(tag) || 0) + 1);
        }
      });
    }
    if (Array.isArray(item.genres)) {
      (item.genres as unknown[]).forEach((g) => {
        const genre = typeof g === "string" ? g : "";
        if (genre && genre.toLowerCase().includes(qLower)) {
          genresMap.set(genre, (genresMap.get(genre) || 0) + 1);
        }
      });
    }
    const narratorsStr = Array.isArray(item.narrators)
      ? item.narrators.join(", ")
      : typeof item.narrators === "string"
      ? item.narrators
      : "";
    if (narratorsStr && narratorsStr.toLowerCase().includes(qLower)) {
      narratorsMap.set(narratorsStr, (narratorsMap.get(narratorsStr) || 0) + 1);
    }
  });

  const tagResults = Array.from(tagsMap.entries()).map(([name, numItems]) => ({
    name,
    numItems,
  }));
  const genreResults = Array.from(genresMap.entries()).map((
    [name, numItems],
  ) => ({ name, numItems }));
  const narratorResults = Array.from(narratorsMap.entries()).map((
    [name, numBooks],
  ) => ({ name, numBooks }));

  return c.json({
    results: formattedItems,
    book: bookResults,
    podcast: podcastResults,
    authors: authorResults,
    series: seriesResults,
    tags: tagResults,
    genres: genreResults,
    narrators: narratorResults,
    episodes: [],
  });
});

librariesRouter.openapi(filterDataRoute, (c) => {
  const emptyFilterData = {
    authors: [],
    genres: [],
    tags: [],
    series: [],
    narrators: [],
    languages: [],
  };
  return c.json(emptyFilterData);
});

librariesRouter.openapi(matchAllRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");

  const processAllChunks = async (startOffset: number) => {
    let offset = startOffset;
    const limit = 10;
    try {
      const { fetchBookMetadata } = await import("../../_shared/coverFetch.ts");

      while (true) {
        const { data: items, error } = await supabase
          .from("library_items")
          .select("id, title, book_authors(authors(name))")
          .eq("library_id", libraryId)
          .range(offset, offset + limit - 1)
          .order("id");

        if (error || !items || items.length === 0) break;

        for (const item of items) {
          const bookItem = item;
          const bookAuthors =
            ((bookItem as Record<string, unknown>)?.book_authors as Record<
              string,
              unknown
            >[]) || [];
          const authorData = bookAuthors[0]?.authors as
            | Record<string, unknown>
            | undefined;
          const authorName = authorData?.name
            ? String(authorData.name || "")
            : "";
          const result = await fetchBookMetadata(item.title || "", authorName);

          if (result && result.metadata) {
            const updates:
              Database["public"]["Tables"]["library_items"]["Update"] = {};
            if (result.metadata.description) {
              updates.description = result.metadata.description;
            }
            if (result.metadata.publishedYear) {
              updates.published_year = result.metadata.publishedYear;
            }
            if (result.metadata.publisher) {
              updates.publisher = result.metadata.publisher;
            }
            if (result.metadata.language) {
              updates.language = result.metadata.language;
            }
            if (result.metadata.genres) updates.genres = result.metadata.genres;

            if (Object.keys(updates).length > 0) {
              await supabase.from("library_items").update(updates).eq(
                "id",
                bookItem.id,
              );
            }

            if (result.cover) {
              const storagePath = `${item.id}/cover.${result.cover.extension}`;
              try {
                await assertStorageQuota(
                  supabase,
                  result.cover.buffer.byteLength,
                );
              } catch (q: any) {
                if (q?.status === 507) {
                  console.warn(
                    `[matchAll] quota exceeded, skip cover for ${item.id}`,
                  );
                  continue;
                }
                throw q;
              }
              await supabase.storage.from("covers").upload(
                storagePath,
                result.cover.buffer,
                { upsert: true, contentType: result.cover.contentType },
              );
              await supabase
                .from("library_items")
                .update({
                  cover_path: storagePath,
                })
                .eq("id", item.id);
            }
          }
        }
        offset += limit;
      }
    } catch (err) {
      console.error(`[libraries] matchAll background task failed:`, err);
    }
  };

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (
    typeof edgeRuntime !== "undefined" &&
    typeof edgeRuntime?.waitUntil === "function"
  ) {
    edgeRuntime.waitUntil(processAllChunks(0));
  } else {
    processAllChunks(0).catch(() => {});
  }

  return c.json(
    {
      success: true,
      message: "Match process started in background",
    },
    202,
  );
});

librariesRouter.openapi(scanRoute, (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ result: "UPTODATE" }, 200);
});

// ── Series ────────────────────────────────────────────────────────────────────
librariesRouter.openapi(seriesRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const {
    data: seriesRows,
    error,
    count,
  } = await supabase
    .from("series")
    .select(
      "*, book_series(library_item_id, sequence, library_items(id, title, cover_path, duration, updated_at, created_at))",
      {
        count: "exact",
      },
    )
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const results = (seriesRows || []).map((s) => {
    const books = (s.book_series || []).map((bs) => {
      const book = Array.isArray(bs.library_items)
        ? bs.library_items[0]
        : bs.library_items;
      // library_items is a one-to-many from books; take the first match
      const libraryItem = book;
      // Return a LibraryItem-compatible shape so the frontend cover pipeline
      // (`getLibraryItemCoverSrc` → `GET /api/items/:id/cover`) resolves to the
      // correct `library_items.id` and the dynamic cover fetcher hits the right row.
      // Falling back to the books-table id keeps cards navigable when no
      // library_item exists, even though the cover would 404 in that case.
      const itemId = libraryItem?.id || bs.library_item_id;
      const coverPath = libraryItem?.cover_path || book?.cover_path || null;
      const toMs = (
        v: unknown,
      ):
        | number
        | undefined => (typeof v === "string" && v
          ? new Date(v).getTime() || undefined
          : undefined);
      return {
        id: itemId,
        sequence: bs.sequence,
        title: book?.title || "",
        addedAt: toMs(libraryItem?.created_at),
        updatedAt: toMs(libraryItem?.updated_at),
        media: {
          // books-table id — keys the per-book progress map on the frontend
          id: book?.id,
          coverPath,
          duration: Number(book?.duration) || undefined,
        },
        // Kept for any legacy consumer of the old flat `cover` field
        cover: coverPath,
      };
    });
    return {
      id: s.id,
      name: s.name,
      nameIgnorePrefix: s.name_ignore_prefix || s.name,
      description: s.description || null,
      libraryId: s.library_id,
      addedAt: new Date(s.created_at).getTime(),
      updatedAt: new Date(s.updated_at || s.created_at).getTime(),
      books,
      numBooks: books.length,
    };
  });

  return c.json({
    results,
    total: count || 0,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
  }, 200);
});

// ── Authors ───────────────────────────────────────────────────────────────────
librariesRouter.openapi(authorsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const {
    data: authorRows,
    error,
    count,
  } = await supabase
    .from("authors")
    .select("*, book_authors(library_item_id)", { count: "exact" })
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const authors = (authorRows || []).map((a) => {
    const bookAuthorsList = (a.book_authors || []) as Record<string, unknown>[];
    return {
      id: a.id,
      name: a.name,
      asin: a.asin || null,
      description: a.description || null,
      imagePath: a.image_path || null,
      libraryId: a.library_id,
      addedAt: new Date(a.created_at).getTime(),
      updatedAt: new Date(a.updated_at || a.created_at).getTime(),
      numBooks: bookAuthorsList.length,
    };
  });

  return c.json({
    authors,
    total: count || 0,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
  }, 200);
});

// ── Collections ───────────────────────────────────────────────────────────────
librariesRouter.openapi(collectionsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const {
    data: collectionRows,
    error,
    count,
  } = await supabase
    .from("collections")
    .select(
      "*, collection_items(library_item_id, order, library_items(id, title, cover_path, duration, updated_at, created_at))",
      { count: "exact" },
    )
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const results = (collectionRows || []).map((cObj) => {
    const books = (cObj.collection_items || []).map((cb) => {
      const book = Array.isArray(cb.library_items)
        ? cb.library_items[0]
        : cb.library_items;
      const libraryItem = book;
      const itemId = libraryItem?.id || cb.library_item_id;
      const coverPath = libraryItem?.cover_path || book?.cover_path || null;
      return {
        id: itemId,
        order: cb.order,
        title: book?.title || "",
        cover: coverPath,
        media: {
          id: book?.id,
          coverPath,
          duration: Number(book?.duration) || undefined,
        },
      };
    });
    // Sort books by order
    books.sort((a: { order?: number | null }, b: { order?: number | null }) =>
      (a.order || 0) - (b.order || 0)
    );

    return {
      id: cObj.id,
      name: cObj.name,
      description: cObj.description || null,
      libraryId: cObj.library_id,
      addedAt: new Date(cObj.created_at).getTime(),
      updatedAt: new Date(cObj.updated_at || cObj.created_at).getTime(),
      books,
      numBooks: books.length,
    };
  });

  return c.json({
    results,
    total: count || 0,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
  }, 200);
});

// ── Playlists ─────────────────────────────────────────────────────────────────
librariesRouter.openapi(playlistsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const {
    data: playlistRows,
    error,
    count,
  } = await supabase
    .from("playlists")
    .select(
      "*, playlist_media_items(media_item_id, order, library_items(id, title, cover_path, duration, updated_at, created_at))",
      { count: "exact" },
    )
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const results = (playlistRows || []).map((pObj) => {
    const items = (pObj.playlist_media_items || []).map((pm) => {
      const book = Array.isArray(pm.library_items)
        ? pm.library_items[0]
        : pm.library_items;
      const libraryItem = book;
      const itemId = libraryItem?.id || pm.media_item_id;
      const coverPath = libraryItem?.cover_path || book?.cover_path || null;
      return {
        id: itemId,
        order: pm.order,
        title: book?.title || "",
        cover: coverPath,
        media: {
          id: book?.id,
          coverPath,
          duration: Number(book?.duration) || undefined,
        },
      };
    });
    // Sort items by order
    items.sort((a: { order?: number | null }, b: { order?: number | null }) =>
      (a.order || 0) - (b.order || 0)
    );

    return {
      id: pObj.id,
      name: pObj.name,
      description: pObj.description || null,
      libraryId: pObj.library_id,
      userId: pObj.user_id,
      addedAt: new Date(pObj.created_at).getTime(),
      updatedAt: new Date(pObj.updated_at || pObj.created_at).getTime(),
      items,
    };
  });

  return c.json({
    results,
    total: count || 0,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
  }, 200);
});

librariesRouter.openapi(personalizedRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: libraryId } = c.req.valid("param");

  // --- Resolve all library_item_ids for this library up-front.
  // This is the idiomatic two-step pattern for PostgREST: filter on a direct
  // column of the driving table rather than using dot-notation join filters,
  // which are unreliable across PostgREST versions and silently drop rows when
  // the embedded filter can't be pushed into the join condition.
  const { data: libraryItemRows } = await supabase.from("library_items").select(
    "id",
  ).eq("library_id", libraryId);

  const libraryItemIds = (libraryItemRows || []).map((r) => r.id);

  // --- Recently Added ---
  // Fetch in a separate query so it stays a simple ORDER BY created_at scan.
  // Shelf payloads are slim (no per-file track data); detail is on demand.
  const { data: recentItems } = (await supabase
    .from("library_items")
    .select(LIST_ITEM_SELECT)
    .eq("library_id", libraryId)
    .order("created_at", { ascending: false })
    .limit(10)) as unknown as { data: any[] | null };

  // Attach progress to recently-added items
  const recentItemIds = (recentItems || []).map((i) => i.id);
  let recentProgressMap = new Map<
    string,
    Database["public"]["Tables"]["media_progress"]["Row"]
  >();
  if (recentItemIds.length > 0) {
    const { data: recentProgressData } = await supabase
      .from("media_progress")
      .select("*")
      .eq("user_id", user.id)
      .in("library_item_id", recentItemIds)
      .is("episode_id", null);
    recentProgressMap = new Map(
      (recentProgressData || []).map((p) => [p.library_item_id, p]),
    );
  }

  const formattedRecent = (recentItems || []).map((item) =>
    mapBookForMobile(
      item as unknown as LibraryItemWithBooks,
      recentProgressMap.get(item.id) ?? null,
      { includeFiles: false },
    )
  );

  // --- Continue Listening & Listen Again ---
  // Drive from media_progress → library_items using a direct .in() filter on
  // library_item_id (a real uuid column with a proper FK after the schema fix).
  // This avoids the !inner dot-notation pattern that silently dropped rows.
  const [continueResult, listenAgainResult] = libraryItemIds.length > 0
    ? await Promise.all([
      supabase
        .from("media_progress")
        .select(
          `*, library_items(${LIST_ITEM_SELECT})`,
        )
        .eq("user_id", user.id)
        .in("library_item_id", libraryItemIds)
        .eq("is_finished", false)
        .eq("hide_from_continue_listening", false)
        .is("episode_id", null)
        .order("last_update", { ascending: false })
        .limit(30),
      supabase
        .from("media_progress")
        .select(
          `*, library_items(${LIST_ITEM_SELECT})`,
        )
        .eq("user_id", user.id)
        .in("library_item_id", libraryItemIds)
        .eq("is_finished", true)
        .is("episode_id", null)
        .order("last_update", { ascending: false })
        .limit(30),
    ])
    : [{ data: [] }, { data: [] }];

  type ProgressWithItem =
    & Database["public"]["Tables"]["media_progress"]["Row"]
    & { library_items?: any };

  const continueItems =
    ((continueResult.data || []) as unknown as ProgressWithItem[])
      .filter((p) => p.library_items)
      .map((p) =>
        mapBookForMobile(
          p.library_items as unknown as LibraryItemWithBooks,
          p,
          { includeFiles: false },
        )
      )
      .filter(Boolean);

  const listenAgainItems =
    ((listenAgainResult.data || []) as unknown as ProgressWithItem[])
      .filter((p) => p.library_items)
      .map((p) =>
        mapBookForMobile(
          p.library_items as unknown as LibraryItemWithBooks,
          p,
          { includeFiles: false },
        )
      )
      .filter(Boolean);

  const shelves: Array<{
    id: string;
    label: string;
    labelStringKey: string;
    type: string;
    entities: unknown[];
    total: number;
  }> = [];

  if (continueItems.length > 0) {
    shelves.push({
      id: "continue-listening",
      label: "Continue Listening",
      labelStringKey: "LabelContinueListening",
      type: "book",
      entities: continueItems,
      total: continueItems.length,
    });
  }

  if (listenAgainItems.length > 0) {
    shelves.push({
      id: "listen-again",
      label: "Listen Again",
      labelStringKey: "LabelListenAgain",
      type: "book",
      entities: listenAgainItems,
      total: listenAgainItems.length,
    });
  }

  shelves.push({
    id: "recently-added",
    label: "Recently Added",
    labelStringKey: "LabelRecentlyAdded",
    type: "book",
    entities: formattedRecent,
    total: formattedRecent.length,
  });

  return c.json(shelves, 200);
});

librariesRouter.openapi(statsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");

  const { data, error } = await (supabase.rpc as any)("get_library_stats", {
    p_library_id: libraryId,
  });

  if (error) {
    console.error("[get_library_stats] Error:", error);
    return c.json({ error: error.message }, 500);
  }

  return c.json(data, 200);
});

librariesRouter.openapi(narratorsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryId } = c.req.valid("param");

  try {
    const { data } = await (supabase as any).from("narrators").select(
      "id, name",
    ).eq("library_id", libraryId);
    return c.json({ narrators: data ?? [] });
  } catch (error: any) {
    console.error("[libraries] Failed to fetch narrators:", error);
    return c.json({ narrators: [] }); // Fallback to empty array just like the old page did
  }
});

librariesRouter.openapi(deduplicateRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");

  try {
    const { data: removedCount, error } = await (supabase as any).rpc(
      "deduplicate_library_items",
    );
    if (error) throw error;

    return c.json({ success: true, removedCount: removedCount || 0 }, 200);
  } catch (err: any) {
    console.error("[deduplicate] Failed:", err);
    return c.json({ error: err.message || err }, 500);
  }
});
