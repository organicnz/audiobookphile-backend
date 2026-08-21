import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { requireAdminRole } from "../_shared/auth.ts";
import { fetchAuthorAvatar } from "../../_shared/avatarFetcher.ts";
import { Context } from "hono";
import { Variables } from "../_shared/types.ts";
import { getErrorMessage } from "../_shared/errors.ts";

export const authorsRouter = createOpenApiRouter();

// ===== Zod schemas for author endpoints =====
const UpdateAuthorSchema = z.object({
  name: z.string().min(1, "Name is required").max(256).optional(),
  description: z.string().optional(), // optional - can be empty string or omitted
  imagePath: z.string().url(
    "image path must be a valid URL pattern (e.g. authors/ID/photo.jpg)",
  ).optional(),
});

const AuthorMatchPayloadSchema = z.object({
  q: z.string().max(256).optional(),
  author: z.string().max(256).optional(), // alias for q - required in payload even if not in schema
});

const AuthorImagePayloadSchema = z.object({
  url: z.string().url(),
});

const ServerErrorSchema = z.object({ error: z.string() });
const ForbiddenSchema = z.object({ error: z.string() });
const NotFoundSchema = z.object({ error: z.string() });
const SuccessSchema = z.object({ success: z.boolean() });
const AuthorResultSchema = z.object({
  updated: z.boolean(),
  author: z.record(z.string(), z.any()),
});
const ImagePathResultSchema = z.object({
  imagePath: z.string(),
});
const SyncAuthorsResultSchema = z.object({
  success: z.boolean(),
  updatedCount: z.number().optional(),
  totalChecked: z.number().optional(),
  error: z.string().optional(),
});

const updateAuthorRoute = {
  method: "patch" as const,
  path: "/:id",
  tags: ["authors"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateAuthorSchema } },
    },
  },
  responses: {
    200: {
      description: "Author updated",
      content: { "application/json": { schema: AuthorResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deleteAuthorRoute = {
  method: "delete" as const,
  path: "/:id",
  tags: ["authors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Author deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const matchAuthorRoute = {
  method: "post" as const,
  path: "/:id/match",
  tags: ["authors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Author matched and updated",
      content: { "application/json": { schema: AuthorResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    404: {
      description: "Author not found",
      content: { "application/json": { schema: NotFoundSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const setAuthorImageRoute = {
  method: "post" as const,
  path: "/:id/image",
  tags: ["authors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Author image updated",
      content: { "application/json": { schema: ImagePathResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deleteAuthorImageRoute = {
  method: "delete" as const,
  path: "/:id/image",
  tags: ["authors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Author image deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const getAuthorImageRoute = {
  method: "get" as const,
  path: "/:id/image",
  tags: ["authors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    302: {
      description: "Redirect to image",
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const syncAuthorsRoute = (path: string) => ({
  method: "post" as const,
  path,
  tags: ["authors"],
  responses: {
    200: {
      description: "Authors synced",
      content: { "application/json": { schema: SyncAuthorsResultSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: SyncAuthorsResultSchema } },
    },
  },
});

authorsRouter.openapi(updateAuthorRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { id: authorId } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = UpdateAuthorSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data, error } = await supabase
    .from("authors")
    .update({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      image_path: parsed.data.imagePath ?? null,
    })
    .eq("id", authorId)
    .select()
    .single();

  if (error) {
    console.error("[authors] Update error:", error);
    return c.json({ error: "Failed to update author" }, 500);
  }
  return c.json({ updated: true, author: data }, 200);
});

authorsRouter.openapi(deleteAuthorRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { id: authorId } = c.req.valid("param");

  const { error } = await supabase.from("authors").delete().eq("id", authorId);
  if (error) {
    console.error("[authors] Delete error:", error);
    return c.json({ error: "Failed to delete author" }, 500);
  }
  return c.json({ success: true }, 200);
});

authorsRouter.openapi(matchAuthorRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const { id: authorId } = c.req.valid("param");

  let payload;
  try {
    payload = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = AuthorMatchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const authorName = (parsed.data.q ?? parsed.data.author) ?? "";

  if (!authorName || authorName.trim() === "") {
    return c.json({ error: "Author name required" }, 400);
  }

  try {
    const res = await fetch(
      `https://openlibrary.org/search/authors.json?q="${
        encodeURIComponent(authorName)
      }"&limit=1`,
    );
    if (!res.ok) return c.json({ error: "Open Library search failed" }, 500);

    const data = await res.json();
    const doc = data?.docs?.[0];
    if (!doc) return c.json({ error: "Author not found" }, 404);

    const updates: any = {};

    if (doc.key) {
      try {
        const keyPath = doc.key.startsWith("/authors/")
          ? doc.key
          : `/authors/${doc.key}`;
        const authorRes = await fetch(`https://openlibrary.org${keyPath}.json`);
        if (authorRes.ok) {
          const authorData = await authorRes.json();
          const bio = authorData.bio?.value || authorData.bio;
          if (typeof bio === "string" && bio.length > 10) {
            updates.description = bio.slice(0, 2000);
          }
          if (authorData.photos?.[0]) {
            doc.photos = authorData.photos;
          }
        }
      } catch {
        /* ignore */
      }
    }

    const db = createClient(supabaseUrl, serviceRoleKey);
    const storagePath = await fetchAuthorAvatar(db, {
      id: authorId,
      name: authorName,
    });
    if (storagePath) {
      updates.image_path = storagePath;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No updates found" }, 404);
    }

    const { data: updated, error } = await supabase.from("authors").update(
      updates,
    ).eq("id", authorId).select().single();
    if (error) {
      console.error("[authors] Update error:", error);
      return c.json({ error: "Failed to update author" }, 500);
    }
    return c.json({ updated: true, author: updated }, 200);
  } catch (e: unknown) {
    const err = e as Error;
    return c.json({ error: err.message }, 500);
  }
});

authorsRouter.openapi(setAuthorImageRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const { id: authorId } = c.req.valid("param");

  let imgData;
  try {
    imgData = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = AuthorImagePayloadSchema.safeParse(imgData);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const imgUrl = parsed.data.url;

  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) return c.json({ error: "Failed to fetch image" }, 500);
  const buf = await imgRes.arrayBuffer();

  const db = createClient(supabaseUrl, serviceRoleKey);
  const storagePath = `authors/${authorId}/photo.jpg`;
  await db.storage.from("covers").upload(storagePath, buf, {
    upsert: true,
    contentType: "image/jpeg",
  });

  await supabase.from("authors").update({ image_path: storagePath }).eq(
    "id",
    authorId,
  );
  return c.json({ imagePath: storagePath }, 200);
});

authorsRouter.openapi(deleteAuthorImageRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const { id: authorId } = c.req.valid("param");

  await supabase.from("authors").update({ image_path: null }).eq(
    "id",
    authorId,
  );
  return c.json({ success: true }, 200);
});

authorsRouter.openapi(getAuthorImageRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: authorId } = c.req.valid("param");

  const { data: author } = await supabase.from("authors").select("image_path")
    .eq("id", authorId).single();

  if (!author || !author.image_path || author.image_path === "missing") {
    return c.redirect(
      "https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/user.svg",
    );
  }

  const { data } = supabase.storage.from("covers").getPublicUrl(
    author.image_path,
  );
  return c.redirect(data.publicUrl);
});

async function handleSyncAuthors(c: Context<{ Variables: Variables }>) {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");

  const limitStr = c.req.query("limit") || "10";
  let limit: number;
  try {
    limit = Math.max(1, parseInt(limitStr, 10));
    if (isNaN(limit)) throw new Error();
  } catch (_e) {
    return c.json({
      error: "Invalid 'limit' parameter (must be a positive integer)",
    }, 400);
  }

  const force = c.req.query("force") === "true";

  try {
    let query = supabase.from("authors").select("id, name, image_path").limit(
      limit,
    );
    if (!force) {
      query = query.or("image_path.is.null,image_path.eq.missing");
    }
    const { data: authors, error } = await query;
    if (error) throw error;

    let updatedCount = 0;
    for (const author of authors || []) {
      if (!author.name) continue;
      const storagePath = await fetchAuthorAvatar(supabase, author as { id: string; name: string });
      if (storagePath) {
        await supabase.from("authors").update({ image_path: storagePath }).eq(
          "id",
          author.id,
        );
        updatedCount++;
      }
    }

    return c.json({
      success: true,
      updatedCount,
      totalChecked: (authors || []).length,
    }, 200);
  } catch (e: unknown) {
    return c.json(
      { success: false, error: getErrorMessage(e) },
      500,
    );
  }
}

authorsRouter.openapi(syncAuthorsRoute("/sync-authors"), handleSyncAuthors);
authorsRouter.openapi(syncAuthorsRoute("/sync"), handleSyncAuthors);
