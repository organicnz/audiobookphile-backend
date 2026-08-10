import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";

export const settingsRouter = new Hono<{ Variables: Variables }>();

// All server-settings endpoints (filesystem, backups, API keys, sessions,
// feeds, shares, genres, tags, backup-database) are server-global by nature
// — strictly admin/root only. Guards are bound to the router's own patterns
// (NOT "*") so they never intercept other routers mounted under /api.
const adminGuard: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  await next();
};

for (const pattern of [
  "/filesystem",
  "/backups",
  "/backups/:id",
  "/backups/:id/apply",
  "/api-keys",
  "/api-keys/:id",
  "/sessions",
  "/sessions/open",
  "/sessions/batch/delete",
  "/sessions/:id",
  "/session/:id/close",
  "/share/mediaitem",
  "/share/mediaitem/:id",
  "/feeds",
  "/feeds/:type/:id/open",
  "/feeds/:id/close",
  "/custom-metadata-providers",
  "/custom-metadata-providers/:id",
  "/genres/:genre",
  "/tags/:tag",
  "/backup-database",
]) {
  settingsRouter.use(pattern, adminGuard);
}

// --- FILESYSTEM ---
settingsRouter.get("/filesystem", (c) => {
  return c.json({
    directories: [{ path: "/", dirname: "/", level: 0 }],
    posix: true,
  });
});

// --- BACKUPS ---
settingsRouter.get("/backups", (c) => c.json({ backups: [] }));
settingsRouter.post("/backups", (c) => c.json({ backups: [] }));
settingsRouter.delete("/backups/:id", (c) => c.json({ backups: [] }));
settingsRouter.get("/backups/:id/apply", (c) => c.json({ success: true }));

// --- API KEYS ---
settingsRouter.get("/api-keys", (c) => c.json({ apiKeys: [] }));
settingsRouter.post(
  "/api-keys",
  (c) => c.json({ apiKey: { id: "mock", key: "mock", name: "Mock Key" } }),
);
settingsRouter.patch(
  "/api-keys/:id",
  (c) => c.json({ apiKey: { id: "mock", key: "mock", name: "Mock Key" } }),
);
settingsRouter.delete("/api-keys/:id", (c) => c.json({ success: true }));

// --- SESSIONS ---
settingsRouter.get("/sessions", (c) => c.json({ sessions: [] }));
settingsRouter.get("/sessions/open", (c) => c.json({ sessions: [] }));
settingsRouter.post("/sessions/batch/delete", (c) => c.json({ success: true }));
settingsRouter.delete("/sessions/:id", (c) => c.json({ success: true }));
settingsRouter.post("/session/:id/close", (c) => c.json({ success: true }));

// --- SHARE MEDIA ITEM ---
settingsRouter.post("/share/mediaitem", (c) =>
  c.json({
    id: "mock-share",
    libraryItemId: "mock",
    slug: "mock-share",
    expiresAt: null,
    createdAt: Date.now(),
  }));
settingsRouter.delete("/share/mediaitem/:id", (c) => c.json({ success: true }));

// --- FEEDS ---
settingsRouter.get("/feeds", (c) => c.json({ feeds: [] }));
settingsRouter.post("/feeds/:type/:id/open", (c) =>
  c.json({
    feed: {
      id: "mock",
      entityId: "mock",
      entityType: "item",
      coverPath: "",
      episodes: [],
    },
  }));
settingsRouter.post("/feeds/:id/close", (c) => c.json({ success: true }));

// --- CUSTOM METADATA PROVIDERS ---
settingsRouter.get(
  "/custom-metadata-providers",
  (c) => c.json({ customMetadataProviders: [] }),
);
settingsRouter.post(
  "/custom-metadata-providers",
  (c) => c.json({ provider: { id: "mock", name: "Mock Provider" } }),
);
settingsRouter.delete(
  "/custom-metadata-providers/:id",
  (c) => c.json({ success: true }),
);

// --- GENRES ---
settingsRouter.delete("/genres/:genre", async (c) => {
  const supabase = c.get("supabase");
  const genre = c.req.param("genre");

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
  return c.json({ numItemsUpdated });
});

settingsRouter.put("/genres/:genre", async (c) => {
  const supabase = c.get("supabase");
  const genre = c.req.param("genre");
  const { newGenreName } = await c.req.json();

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
  return c.json({ genreMerged, numItemsUpdated });
});

// --- TAGS ---
settingsRouter.delete("/tags/:tag", async (c) => {
  const supabase = c.get("supabase");
  const tag = c.req.param("tag");

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
  return c.json({ numItemsUpdated });
});

settingsRouter.put("/tags/:tag", async (c) => {
  const supabase = c.get("supabase");
  const tag = c.req.param("tag");
  const { newTagName } = await c.req.json();

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
  return c.json({ tagMerged, numItemsUpdated });
});

// --- STORAGE SYNC ---
async function handleStorageSync(c: any) {
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
      });
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
      });
    }

    return c.json({
      synced: true,
      orphans,
      totalAudioFiles: files.length,
    });
  } catch (e: any) {
    return c.json({
      synced: false,
      error: e.message || "Storage sync failed",
      orphans: [],
      totalAudioFiles: 0,
    }, 500);
  }
}

settingsRouter.all("/storage-sync", handleStorageSync);

// --- BACKUP DATABASE ---
async function handleBackupDatabase(c: any) {
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
    });
  } catch (e: any) {
    return c.json({
      success: false,
      error: e.message || "Backup failed",
    }, 500);
  }
}

settingsRouter.post("/backup-database", handleBackupDatabase);
