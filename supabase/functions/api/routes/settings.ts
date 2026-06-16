import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

export const settingsRouter = new Hono<{ Variables: Variables }>();

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
settingsRouter.post(
  "/share/mediaitem",
  (c) =>
    c.json({
      id: "mock-share",
      libraryItemId: "mock",
      slug: "mock-share",
      expiresAt: null,
      createdAt: Date.now(),
    }),
);
settingsRouter.delete("/share/mediaitem/:id", (c) => c.json({ success: true }));

// --- FEEDS ---
settingsRouter.get("/feeds", (c) => c.json({ feeds: [] }));
settingsRouter.post(
  "/feeds/:type/:id/open",
  (c) =>
    c.json({
      feed: {
        id: "mock",
        entityId: "mock",
        entityType: "item",
        coverPath: "",
        episodes: [],
      },
    }),
);
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

  const { data: books } = await supabase.from("books").select("id, genres");
  let numItemsUpdated = 0;
  for (const book of books ?? []) {
    const genres = book.genres as string[] | null;
    if (Array.isArray(genres) && genres.includes(genre)) {
      const newGenres = genres.filter((g) => g !== genre);
      await supabase.from("books").update({ genres: newGenres }).eq(
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

  const { data: books } = await supabase.from("books").select("id, genres");
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
      await supabase.from("books").update({ genres: [...new Set(newGenres)] })
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

  const { data: books } = await supabase.from("books").select("id, tags");
  let numItemsUpdated = 0;
  for (const book of books ?? []) {
    const tags = book.tags as string[] | null;
    if (Array.isArray(tags) && tags.includes(tag)) {
      const newTags = tags.filter((t) => t !== tag);
      await supabase.from("books").update({ tags: newTags }).eq("id", book.id);
      numItemsUpdated++;
    }
  }
  return c.json({ numItemsUpdated });
});

settingsRouter.put("/tags/:tag", async (c) => {
  const supabase = c.get("supabase");
  const tag = c.req.param("tag");
  const { newTagName } = await c.req.json();

  const { data: books } = await supabase.from("books").select("id, tags");
  let numItemsUpdated = 0;
  let tagMerged = false;
  for (const book of books ?? []) {
    const tags = book.tags as string[] | null;
    if (Array.isArray(tags) && tags.includes(tag)) {
      const newTags = tags.map((t) => (t === tag ? newTagName : t));
      if (newTags.filter((t) => t === newTagName).length > 1) {
        tagMerged = true;
      }
      await supabase.from("books").update({ tags: [...new Set(newTags)] }).eq(
        "id",
        book.id,
      );
      numItemsUpdated++;
    }
  }
  return c.json({ tagMerged, numItemsUpdated });
});
