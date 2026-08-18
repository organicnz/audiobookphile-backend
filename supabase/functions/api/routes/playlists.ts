import { z } from "zod";
import { Hono } from "hono";

import { Variables } from "../_shared/types.ts";
export const playlistsRouter = new Hono<{ Variables: Variables }>();

// ===== Zod schemas for playlist endpoints =====
const PlaylistCreateSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  items: z.array(z.number()).optional(), // array of library item IDs (auto-ordered)
});

const PlaylistUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});

playlistsRouter.post("/", async (c) => {
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
        z.string().uuid().safeParse(itemId.toString());
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
  if (error) throw error;

  if (items && items.length > 0) {
    const playlistItems = items.map((item: any, index: number) => ({
      id: crypto.randomUUID(),
      playlist_id: data.id,
      media_item_id: item,
      order: index,
      media_item_type: "book",
    }));
    await supabase.from("playlist_media_items").insert(playlistItems);
  }
  return c.json(data);
});

playlistsRouter.patch("/:id", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");

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
  if (error) throw error;
  return c.json(data);
});

playlistsRouter.post("/:id/items", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");

  let rows;
  try {
    rows = await c.req.json(); // Array of items with libraryItemId
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate the payload structure (should be array of objects with libraryItemId)
  if (!Array.isArray(rows)) {
    return c.json({ error: "Payload must be an array" }, 400);
  }

  for (const r of rows) {
    if (!r.libraryItemId || typeof r.libraryItemId !== "string") {
      return c.json(
        { error: "Each item must have a libraryItemId string" },
        400,
      );
    }
    try {
      z.string().uuid().safeParse(r.libraryItemId);
    } catch (_e) {
      return c.json(
        { error: `Invalid library item ID: ${r.libraryItemId}` },
        400,
      );
    }
  }

  const { count } = await supabase
    .from("playlist_media_items")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("playlist_id", playlistId);

  // Validate order field exists and is a number (optional)
  for (const r of rows) {
    if ("order" in r && typeof r.order !== "number") {
      return c.json({ error: "'order' must be a number" }, 400);
    }
  }

  const insertRows = rows.map((r: any, index: number) => ({
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
  if (error) throw error;
  return c.json(data);
});

playlistsRouter.delete("/:id/items", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");
  const item = await c.req.json();

  let query = supabase.from("playlist_media_items").delete().eq(
    "playlist_id",
    playlistId,
  ).eq("media_item_id", item.libraryItemId);
  // If we had episode differentiation, we'd do it here, but media_item_id maps to library_item_id generally
  await query;

  const { data, error } = await supabase.from("playlists").select(
    "*, playlist_media_items(*)",
  ).eq("id", playlistId).single();
  if (error) throw error;
  return c.json(data);
});

playlistsRouter.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { libraryId, name, description, items } = await c.req.json();
  const newId = crypto.randomUUID();

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
  if (error) throw error;

  if (items && items.length > 0) {
    const playlistItems = items.map((item: any, index: number) => ({
      playlist_id: data.id,
      media_item_id: item.libraryItemId,
      order: index,
      media_item_type: "book",
    }));
    await supabase.from("playlist_media_items").insert(playlistItems);
  }
  return c.json(data);
});

playlistsRouter.patch("/:id", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");
  const { name, description } = await c.req.json();

  const { data, error } = await supabase
    .from("playlists")
    .update({
      name,
      description,
    })
    .eq("id", playlistId)
    .select()
    .single();
  if (error) throw error;
  return c.json(data);
});

playlistsRouter.post("/:id/items", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");
  const rows = await c.req.json(); // Array of items

  const { count } = await supabase
    .from("playlist_media_items")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("playlist_id", playlistId);

  const insertRows = rows.map((r: any, index: number) => ({
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
  if (error) throw error;
  return c.json(data);
});

playlistsRouter.delete("/:id/items", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");
  const item = await c.req.json();

  let query = supabase.from("playlist_media_items").delete().eq(
    "playlist_id",
    playlistId,
  ).eq("media_item_id", item.libraryItemId);
  // If we had episode differentiation, we'd do it here, but media_item_id maps to library_item_id generally
  await query;

  const { data, error } = await supabase.from("playlists").select(
    "*, playlist_media_items(*)",
  ).eq("id", playlistId).single();
  if (error) throw error;
  return c.json(data);
});
