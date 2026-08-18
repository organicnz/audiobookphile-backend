import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const playlistsRouter = createOpenApiRouter();

// ===== Zod schemas for playlist endpoints =====
const PlaylistCreateSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  items: z.array(z.string()).optional(), // array of library item IDs (auto-ordered)
});

const PlaylistUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});

const PlaylistItemsAddSchema = z.array(
  z.object({
    libraryItemId: z.string().uuid(),
    order: z.number().optional(),
  }),
);

const PlaylistItemDeleteSchema = z.object({
  libraryItemId: z.string().uuid(),
});

const ServerErrorSchema = z.object({ error: z.string() });
const PlaylistResultSchema = z.record(z.string(), z.any());

const createPlaylistRoute = {
  method: "post" as const,
  path: "/",
  tags: ["playlists"],
  request: {
    body: {
      content: { "application/json": { schema: PlaylistCreateSchema } },
    },
  },
  responses: {
    200: {
      description: "Playlist created",
      content: { "application/json": { schema: PlaylistResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updatePlaylistRoute = {
  method: "patch" as const,
  path: "/:id",
  tags: ["playlists"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: PlaylistUpdateSchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Playlist updated",
      content: { "application/json": { schema: PlaylistResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const addPlaylistItemsRoute = {
  method: "post" as const,
  path: "/:id/items",
  tags: ["playlists"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: PlaylistItemsAddSchema } },
    },
  },
  responses: {
    200: {
      description: "Items added to playlist",
      content: { "application/json": { schema: PlaylistResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deletePlaylistItemRoute = {
  method: "delete" as const,
  path: "/:id/items",
  tags: ["playlists"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: PlaylistItemDeleteSchema } },
    },
  },
  responses: {
    200: {
      description: "Item removed from playlist",
      content: { "application/json": { schema: PlaylistResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

playlistsRouter.openapi(createPlaylistRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = PlaylistCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { libraryId, name, description, items } = parsed.data;
  const newId = crypto.randomUUID();

  // Validate item IDs (if provided) - each must be a valid UUID string
  if (items && items.length > 0) {
    for (const itemId of items) {
      try {
        z.string().uuid().parse(itemId);
      } catch (_e) {
        return c.json({ error: `Invalid library item ID: ${itemId}` }, 400);
      }
    }
  }

  const { data, error } = await supabase
    .from("playlists")
    .insert({
      id: newId,
      library_id: libraryId,
      name,
      description: description ?? null,
      user_id: user.id,
    })
    .select()
    .single();
  if (error) {
    console.error("[playlists] Create error:", error);
    return c.json({ error: "Failed to create playlist" }, 500);
  }

  if (items && items.length > 0) {
    const playlistItems = items.map((item: string, index: number) => ({
      id: crypto.randomUUID(),
      playlist_id: data.id,
      media_item_id: item,
      order: index,
      media_item_type: "book",
    }));
    await supabase.from("playlist_media_items").insert(playlistItems);
  }
  return c.json(data, 200);
});

playlistsRouter.openapi(updatePlaylistRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: playlistId } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema (partial update allowed - optional fields)
  const parsed = PlaylistUpdateSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { name, description } = parsed.data;

  const { data, error } = await supabase
    .from("playlists")
    .update({
      name,
      description,
    })
    .eq("id", playlistId)
    .select()
    .single();
  if (error) {
    console.error("[playlists] Update error:", error);
    return c.json({ error: "Failed to update playlist" }, 500);
  }
  return c.json(data, 200);
});

playlistsRouter.openapi(addPlaylistItemsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: playlistId } = c.req.valid("param");

  let rows;
  try {
    rows = await c.req.json(); // Array of items with libraryItemId
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = PlaylistItemsAddSchema.safeParse(rows);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { count } = await supabase
    .from("playlist_media_items")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("playlist_id", playlistId);

  const insertRows = parsed.data.map((r, index: number) => ({
    id: crypto.randomUUID(),
    playlist_id: playlistId,
    media_item_id: r.libraryItemId,
    order: (count ?? 0) + index,
    media_item_type: "book",
  }));
  await supabase.from("playlist_media_items").insert(insertRows);

  const { data, error } = await supabase.from("playlists").select(
    "*, playlist_media_items(*)",
  ).eq("id", playlistId).single();
  if (error) {
    console.error("[playlists] Add items error:", error);
    return c.json({ error: "Failed to add items to playlist" }, 500);
  }
  return c.json(data, 200);
});

playlistsRouter.openapi(deletePlaylistItemRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: playlistId } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = PlaylistItemDeleteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  let query = supabase.from("playlist_media_items").delete().eq(
    "playlist_id",
    playlistId,
  ).eq("media_item_id", parsed.data.libraryItemId);
  // If we had episode differentiation, we'd do it here, but media_item_id maps to library_item_id generally
  await query;

  const { data, error } = await supabase.from("playlists").select(
    "*, playlist_media_items(*)",
  ).eq("id", playlistId).single();
  if (error) {
    console.error("[playlists] Delete item error:", error);
    return c.json({ error: "Failed to delete item from playlist" }, 500);
  }
  return c.json(data, 200);
});
