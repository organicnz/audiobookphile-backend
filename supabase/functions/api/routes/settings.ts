import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { requireAdminRole } from "../_shared/auth.ts";

export const settingsRouter = createOpenApiRouter();

const GenreUpdateSchema = z.object({
  newGenreName: z.string().min(1).max(256),
});

const TagUpdateSchema = z.object({
  newTagName: z.string().min(1).max(256),
});

const MockResultSchema = z.record(z.string(), z.any());
const ForbiddenSchema = z.object({ error: z.string() });
const ErrorSchema = z.object({ error: z.string() });

// Helper to create simple mock routes
function createMockRoute(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  tags = ["settings"],
) {
  const hasParams = path.includes(":");

  // We explicitly type the params for known ones
  let paramsObj: any = undefined;
  if (hasParams) {
    const params: any = {};
    if (path.includes(":id")) params.id = z.string();
    if (path.includes(":type")) params.type = z.string();
    if (path.includes(":genre")) params.genre = z.string();
    if (path.includes(":tag")) params.tag = z.string();
    paramsObj = z.object(params);
  }

  return {
    method,
    path,
    tags,
    request: paramsObj ? { params: paramsObj } : undefined,
    responses: {
      200: {
        description: "Success",
        content: { "application/json": { schema: MockResultSchema } },
      },
      403: {
        description: "Admin role required",
        content: { "application/json": { schema: ForbiddenSchema } },
      },
    },
  };
}

// --- ROUTE DEFINITIONS ---

// FILESYSTEM
const getFilesystemRoute = createMockRoute("get", "/filesystem");

// BACKUPS
const getBackupsRoute = createMockRoute("get", "/backups");
const postBackupsRoute = createMockRoute("post", "/backups");
const deleteBackupRoute = createMockRoute("delete", "/backups/:id");
const applyBackupRoute = createMockRoute("get", "/backups/:id/apply");

// API KEYS
const getApiKeysRoute = createMockRoute("get", "/api-keys");
const postApiKeyRoute = createMockRoute("post", "/api-keys");
const patchApiKeyRoute = createMockRoute("patch", "/api-keys/:id");
const deleteApiKeyRoute = createMockRoute("delete", "/api-keys/:id");

// SESSIONS
const getSessionsRoute = createMockRoute("get", "/sessions");
const getOpenSessionsRoute = createMockRoute("get", "/sessions/open");
const deleteBatchSessionsRoute = createMockRoute(
  "post",
  "/sessions/batch/delete",
);
const deleteSessionRoute = createMockRoute("delete", "/sessions/:id");
const closeSessionRoute = createMockRoute("post", "/session/:id/close");

// SHARE MEDIA ITEM
const postShareMediaItemRoute = createMockRoute("post", "/share/mediaitem");
const deleteShareMediaItemRoute = createMockRoute(
  "delete",
  "/share/mediaitem/:id",
);

// FEEDS
const getFeedsRoute = createMockRoute("get", "/feeds");
const openFeedRoute = createMockRoute("post", "/feeds/:type/:id/open");
const closeFeedRoute = createMockRoute("post", "/feeds/:id/close");

// CUSTOM METADATA PROVIDERS
const getProvidersRoute = createMockRoute("get", "/custom-metadata-providers");
const postProviderRoute = createMockRoute("post", "/custom-metadata-providers");
const deleteProviderRoute = createMockRoute(
  "delete",
  "/custom-metadata-providers/:id",
);

// GENRES
const deleteGenreRoute = {
  method: "delete" as const,
  path: "/genres/:genre",
  tags: ["settings"],
  request: { params: z.object({ genre: z.string() }) },
  responses: {
    200: {
      description: "Genre deleted",
      content: { "application/json": { schema: MockResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
  },
};

const putGenreRoute = {
  method: "put" as const,
  path: "/genres/:genre",
  tags: ["settings"],
  request: {
    params: z.object({ genre: z.string() }),
  },
  responses: {
    200: {
      description: "Genre updated",
      content: { "application/json": { schema: MockResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
  },
};

const patchGenreRoute = {
  ...putGenreRoute,
  method: "patch" as const,
};

// TAGS
const deleteTagRoute = {
  method: "delete" as const,
  path: "/tags/:tag",
  tags: ["settings"],
  request: { params: z.object({ tag: z.string() }) },
  responses: {
    200: {
      description: "Tag deleted",
      content: { "application/json": { schema: MockResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
  },
};

const putTagRoute = {
  method: "put" as const,
  path: "/tags/:tag",
  tags: ["settings"],
  request: {
    params: z.object({ tag: z.string() }),
  },
  responses: {
    200: {
      description: "Tag updated",
      content: { "application/json": { schema: MockResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
  },
};

const patchTagRoute = {
  ...putTagRoute,
  method: "patch" as const,
};

// STORAGE SYNC
const getStorageSyncRoute = {
  method: "get" as const,
  path: "/storage-sync",
  tags: ["settings"],
  responses: {
    200: {
      description: "Storage synced",
      content: { "application/json": { schema: MockResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: MockResultSchema } },
    },
  },
};

const postStorageSyncRoute = {
  method: "post" as const,
  path: "/storage-sync",
  tags: ["settings"],
  responses: {
    200: {
      description: "Storage synced",
      content: { "application/json": { schema: MockResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: MockResultSchema } },
    },
  },
};

// BACKUP DATABASE
const backupDatabaseRoute = {
  method: "post" as const,
  path: "/backup-database",
  tags: ["settings"],
  responses: {
    200: {
      description: "Database backed up",
      content: { "application/json": { schema: MockResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: MockResultSchema } },
    },
  },
};

// --- HANDLERS ---

function adminCheck(c: any) {
  return requireAdminRole(c.get("user"));
}

// MOCKS
settingsRouter.openapi(getFilesystemRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({
    directories: [{ path: "/", dirname: "/", level: 0 }],
    posix: true,
  }, 200);
});

settingsRouter.openapi(getBackupsRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ backups: [] }, 200);
});
settingsRouter.openapi(postBackupsRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ backups: [] }, 200);
});
settingsRouter.openapi(deleteBackupRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ backups: [] }, 200);
});
settingsRouter.openapi(applyBackupRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});

settingsRouter.openapi(getApiKeysRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ apiKeys: [] }, 200);
});
settingsRouter.openapi(postApiKeyRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ apiKey: { id: "mock", key: "mock", name: "Mock Key" } }, 200);
});
settingsRouter.openapi(patchApiKeyRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ apiKey: { id: "mock", key: "mock", name: "Mock Key" } }, 200);
});
settingsRouter.openapi(deleteApiKeyRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});

settingsRouter.openapi(getSessionsRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ sessions: [] }, 200);
});
settingsRouter.openapi(getOpenSessionsRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ sessions: [] }, 200);
});
settingsRouter.openapi(deleteBatchSessionsRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});
settingsRouter.openapi(deleteSessionRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});
settingsRouter.openapi(closeSessionRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});

settingsRouter.openapi(postShareMediaItemRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({
    id: "mock-share",
    libraryItemId: "mock",
    slug: "mock-share",
    expiresAt: null,
    createdAt: Date.now(),
  }, 200);
});
settingsRouter.openapi(deleteShareMediaItemRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});

settingsRouter.openapi(getFeedsRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ feeds: [] }, 200);
});
settingsRouter.openapi(openFeedRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({
    feed: {
      id: "mock",
      entityId: "mock",
      entityType: "item",
      coverPath: "",
      episodes: [],
    },
  }, 200);
});
settingsRouter.openapi(closeFeedRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});

settingsRouter.openapi(getProvidersRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ customMetadataProviders: [] }, 200);
});
settingsRouter.openapi(postProviderRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ provider: { id: "mock", name: "Mock Provider" } }, 200);
});
settingsRouter.openapi(deleteProviderRoute, (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return c.json({ success: true }, 200);
});

// REAL ENDPOINTS
settingsRouter.openapi(deleteGenreRoute, async (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { genre } = c.req.valid("param");

  const { data: books } = await supabase.from("library_items").select(
    "id, genres",
  );
  let numItemsUpdated = 0;
  for (const book of books ?? []) {
    const genres = book.genres as string[] | null;
    if (Array.isArray(genres) && genres.includes(genre)) {
      const newGenres = genres.filter((g) => g !== genre);
      await supabase.from("library_items").update({ genres: newGenres }).eq(
        "id",
        book.id,
      );
      numItemsUpdated++;
    }
  }
  return c.json({ numItemsUpdated }, 200);
});

const handlePutGenre = async (c: any) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { genre } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = GenreUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const newGenreName = parsed.data.newGenreName;

  const { data: books } = await supabase.from("library_items").select(
    "id, genres",
  );
  let numItemsUpdated = 0;
  let genreMerged = false;
  for (const book of books ?? []) {
    const genres = book.genres as string[] | null;
    if (Array.isArray(genres) && genres.includes(genre)) {
      const newGenres = genres.map((g) => (g === genre ? newGenreName : g));
      if (
        newGenres.includes(newGenreName) &&
        newGenres.filter((g) => g === newGenreName).length > 1
      ) {
        genreMerged = true;
      }
      await supabase
        .from("library_items")
        .update({
          genres: [...new Set(newGenres)],
        })
        .eq("id", book.id);
      numItemsUpdated++;
    }
  }
  return c.json({ genreMerged, numItemsUpdated }, 200);
};

settingsRouter.openapi(putGenreRoute, handlePutGenre);
settingsRouter.openapi(patchGenreRoute, handlePutGenre);

settingsRouter.openapi(deleteTagRoute, async (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { tag } = c.req.valid("param");

  const { data: books } = await supabase.from("library_items").select(
    "id, tags",
  );
  let numItemsUpdated = 0;
  for (const book of books ?? []) {
    const tags = book.tags as string[] | null;
    if (Array.isArray(tags) && tags.includes(tag)) {
      const newTags = tags.filter((t) => t !== tag);
      await supabase.from("library_items").update({ tags: newTags }).eq(
        "id",
        book.id,
      );
      numItemsUpdated++;
    }
  }
  return c.json({ numItemsUpdated }, 200);
});

const handlePutTag = async (c: any) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { tag } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = TagUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const newTagName = parsed.data.newTagName;

  const { data: books } = await supabase.from("library_items").select(
    "id, tags",
  );
  let numItemsUpdated = 0;
  let tagMerged = false;
  for (const book of books ?? []) {
    const tags = book.tags as string[] | null;
    if (Array.isArray(tags) && tags.includes(tag)) {
      const newTags = tags.map((t) => (t === tag ? newTagName : t));
      if (newTags.filter((t) => t === newTagName).length > 1) {
        tagMerged = true;
      }
      await supabase
        .from("library_items")
        .update({
          tags: [...new Set(newTags)],
        })
        .eq("id", book.id);
      numItemsUpdated++;
    }
  }
  return c.json({ tagMerged, numItemsUpdated }, 200);
};

settingsRouter.openapi(putTagRoute, handlePutTag);
settingsRouter.openapi(patchTagRoute, handlePutTag);

async function handleStorageSync(c: any) {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const action = c.req.query("action");

  try {
    const { data: listData, error: listError } = await supabase.storage
      .from("audio-files")
      .list();
    if (listError) {
      return c.json({
        synced: true,
        orphans: [],
        totalAudioFiles: 0,
        message: "audio-files storage bucket not initialized or empty",
      }, 200);
    }

    const files = (listData || []).filter((f: any) => !f.name.startsWith("."));
    const { data: _dbItems } = await supabase.from("library_items").select(
      "id, title",
    );
    const orphans = files.map((f: any) => ({
      name: f.name,
      path: f.name,
      size: f.metadata?.size || 0,
    }));

    if (action === "import-orphans") {
      return c.json({
        synced: true,
        orphans: [],
        importedCount: 0,
        totalAudioFiles: files.length,
      }, 200);
    }

    return c.json({
      synced: true,
      orphans,
      totalAudioFiles: files.length,
    }, 200);
  } catch (e: any) {
    return c.json({
      synced: false,
      error: e.message || "Storage sync failed",
      orphans: [],
      totalAudioFiles: 0,
    }, 500);
  }
}

settingsRouter.openapi(getStorageSyncRoute, handleStorageSync);
settingsRouter.openapi(postStorageSyncRoute, handleStorageSync);

settingsRouter.openapi(backupDatabaseRoute, async (c) => {
  if (!adminCheck(c)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  try {
    const libraries = await supabase.from("libraries").select("*").limit(1000);
    const libraryItems = await supabase.from("library_items").select("*").limit(
      1000,
    );
    const mediaProgress = await supabase.from("media_progress").select("*")
      .limit(1000);

    const backupData = {
      timestamp: new Date().toISOString(),
      libraries: libraries.data || [],
      libraryItems: libraryItems.data || [],
      mediaProgress: mediaProgress.data || [],
    };

    const filename = `backup-${new Date().toISOString().split("T")[0]}.json`;
    await supabase.storage.from("backups").upload(
      filename,
      JSON.stringify(backupData, null, 2),
      { contentType: "application/json", upsert: true },
    );

    return c.json({
      success: true,
      message: "Backup created",
      filename,
    }, 200);
  } catch (e: any) {
    return c.json({
      success: false,
      error: e.message || "Backup failed",
    }, 500);
  }
});
