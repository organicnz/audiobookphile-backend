import { Hono } from "hono";

import { Variables } from "../_shared/types.ts";
export const playlistsRouter = new Hono<{ Variables: Variables }>();

playlistsRouter.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { libraryId, name, description, items } = await c.req.json();
  const newId = crypto.randomUUID();

  const { data, error } = await supabase.from("playlists").insert({
    id: newId,
    library_id: libraryId,
    name,
    description: description ?? null,
    user_id: user.id,
  }).select().single();
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

  const { data, error } = await supabase.from("playlists").update({
    name,
    description,
  }).eq("id", playlistId).select().single();
  if (error) throw error;
  return c.json(data);
});

playlistsRouter.post("/:id/items", async (c) => {
  const supabase = c.get("supabase");
  const playlistId = c.req.param("id");
  const rows = await c.req.json(); // Array of items

  const { count } = await supabase.from("playlist_media_items").select("*", {
    count: "exact",
    head: true,
  }).eq("playlist_id", playlistId);

  const insertRows = rows.map((r: any, index: number) => ({
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
  // If we had episode differentiation, we'd do it here, but media_item_id maps to book_id generally
  await query;

  const { data, error } = await supabase.from("playlists").select(
    "*, playlist_media_items(*)",
  ).eq("id", playlistId).single();
  if (error) throw error;
  return c.json(data);
});
