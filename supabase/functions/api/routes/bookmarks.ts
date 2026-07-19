import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

export const bookmarksRouter = new Hono<{ Variables: Variables }>();

bookmarksRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");

  const libraryItemId = c.req.query("libraryItemId");
  if (!libraryItemId) {
    return c.json({ error: "libraryItemId query parameter is required" }, 400);
  }

  const { data: bookmarks, error } = await supabase
    .from("bookmarks")
    .select("*")
    .eq("user_id", user.id)
    .eq("library_item_id", libraryItemId)
    .order("time_pos", { ascending: true });

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ bookmarks: bookmarks || [] });
});

bookmarksRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");
  
  const body = await c.req.json().catch(() => ({}));
  const { library_item_id, time_pos, title } = body;

  if (!library_item_id || time_pos === undefined) {
    return c.json({ error: "library_item_id and time_pos are required" }, 400);
  }

  const { data: bookmark, error } = await supabase
    .from("bookmarks")
    .insert({
      user_id: user.id,
      library_item_id,
      time_pos,
      title: title || null,
    })
    .select("*")
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ bookmark });
});

bookmarksRouter.patch("/:id", async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");
  const id = c.req.param("id");
  
  const body = await c.req.json().catch(() => ({}));
  const { time_pos, title } = body;

  const updates: any = {};
  if (time_pos !== undefined) updates.time_pos = time_pos;
  if (title !== undefined) updates.title = title;

  const { data: bookmark, error } = await supabase
    .from("bookmarks")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("*")
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ bookmark });
});

bookmarksRouter.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");
  const id = c.req.param("id");

  const { error } = await supabase
    .from("bookmarks")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true });
});
