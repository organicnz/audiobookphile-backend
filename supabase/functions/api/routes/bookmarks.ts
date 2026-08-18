import { z } from "zod";
import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

// ===== Zod schemas for bookmark endpoints =====
export const BookmarkCreateSchema = z.object({
  library_item_id: z.string().uuid("Invalid library item ID"),
  time_pos: z.number().min(0).max(999999), // milliseconds up to ~12.5 hours
  title: z.string().max(256).optional(),
});

export const BookmarkUpdateSchema = z.object({
  time_pos: z.number().min(0).max(999999).optional(),
  title: z.string().max(256).optional(),
});

export const bookmarksRouter = new Hono<{ Variables: Variables }>();

bookmarksRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");

  let libraryItemId = c.req.query("libraryItemId");
  if (!libraryItemId) {
    return c.json({ error: "libraryItemId query parameter is required" }, 400);
  }

  // Validate UUID format with Zod
  const uuidSchema = z.string().uuid();
  const parsed = uuidSchema.safeParse(libraryItemId);
  if (!parsed.success) {
    return c.json({ error: "Invalid library item ID (UUID required)" }, 400);
  }

  libraryItemId = parsed.data;

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

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = BookmarkCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { library_item_id, time_pos, title } = parsed.data;

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

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema (some fields can be omitted for partial updates)
  const parsed = BookmarkUpdateSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { time_pos, title } = parsed.data;

  const updates: any = {};
  if (time_pos !== undefined) updates.time_pos = time_pos;
  if (title !== undefined) updates.title = title;

  const { data: bookmark, error } = await supabase.from("bookmarks").update(
    updates,
  ).eq("id", id).eq("user_id", user.id).select("*").single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ bookmark });
});

bookmarksRouter.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");
  const id = c.req.param("id");

  const { error } = await supabase.from("bookmarks").delete().eq("id", id).eq(
    "user_id",
    user.id,
  );

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true });
});
