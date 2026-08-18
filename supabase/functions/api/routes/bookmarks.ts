import { createOpenApiRouter, z } from "../_shared/openapi.ts";

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

export const bookmarksRouter = createOpenApiRouter();

const ServerErrorSchema = z.object({ error: z.string() });
const BookmarkResultSchema = z.object({
  bookmark: z.record(z.string(), z.any()),
});
const BookmarkListSchema = z.object({
  bookmarks: z.array(z.record(z.string(), z.any())),
});
const SuccessSchema = z.object({ success: z.boolean() });

const listBookmarksRoute = {
  method: "get" as const,
  path: "/",
  tags: ["bookmarks"],
  responses: {
    200: {
      description: "List of bookmarks for a library item",
      content: { "application/json": { schema: BookmarkListSchema } },
    },
    400: {
      description: "Missing or invalid libraryItemId",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const createBookmarkRoute = {
  method: "post" as const,
  path: "/",
  tags: ["bookmarks"],
  request: {
    body: {
      content: {
        "application/json": { schema: BookmarkCreateSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Bookmark created",
      content: { "application/json": { schema: BookmarkResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.any()),
        },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updateBookmarkRoute = {
  method: "patch" as const,
  path: "/:id",
  tags: ["bookmarks"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Bookmark updated",
      content: { "application/json": { schema: BookmarkResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.any()),
        },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deleteBookmarkRoute = {
  method: "delete" as const,
  path: "/:id",
  tags: ["bookmarks"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Bookmark deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

bookmarksRouter.openapi(listBookmarksRoute, async (c) => {
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

  return c.json({ bookmarks: bookmarks || [] }, 200);
});

bookmarksRouter.openapi(createBookmarkRoute, async (c) => {
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

  return c.json({ bookmark }, 200);
});

bookmarksRouter.openapi(updateBookmarkRoute, async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");
  const { id } = c.req.valid("param");

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

  return c.json({ bookmark }, 200);
});

bookmarksRouter.openapi(deleteBookmarkRoute, async (c) => {
  const user = c.get("user")!;
  const supabase: any = c.get("supabase");
  const { id } = c.req.valid("param");

  const { error } = await supabase.from("bookmarks").delete().eq("id", id).eq(
    "user_id",
    user.id,
  );

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true }, 200);
});
