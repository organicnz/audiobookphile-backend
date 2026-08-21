import { Context } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { LibraryItemWithBooks, mapBookForMobile } from "../../api/mappers.ts";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";
import { getProxyOrigin } from "../../api/_shared/proxy.ts";
import {
  generateChapterAIInsights,
  matchExistingBookWithZAI,
} from "../../_shared/zai.ts";
import { fetchBookMetadata } from "../../_shared/coverFetch.ts";
import { ensureBookAIInsights } from "../aiService.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import {
  FUZZY_MATCH_RATIO,
  SEARCH_MATCH_COUNT,
  SEARCH_MATCH_THRESHOLD,
} from "../_shared/constants.ts";
import { getErrorMessage } from "../_shared/errors.ts";

export const itemsRouter = createOpenApiRouter();

// =========================
// OpenAPI Schemas & Route Definitions
// =========================

// Deep item payloads come from the shared mappers; catchall keeps the spec
// honest without pinning every field of the evolving book shape.
const BookPayloadSchema = z.any();
const MediaIdSchema = z.object({ mediaId: z.string().nullable() });
const SimilarItemsSchema = z.any();
const BatchItemsSchema = z.any();
const InsightsSchema = z.any();
const SyncResultSchema = z.object({
  success: z.boolean(),
  updated: z.number().optional(),
  processed: z.number().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});
const CoverUploadResultSchema = z.object({ updated: z.boolean() });
const ServerErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  stack: z.string().optional(),
  details: z.union([z.string(), z.array(z.any())]).optional(),
  hint: z.string().optional(),
});
const ForbiddenSchema = z.object({ error: z.string() });

const itemDetailRoute = {
  method: "get" as const,
  path: "/:id",
  tags: ["items"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Full item payload (book or podcast)",
      content: { "application/json": { schema: BookPayloadSchema } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const checkExistingRoute = {
  method: "get" as const,
  path: "/check-existing",
  tags: ["items"],
  request: {
    query: z.object({
      title: z.string().max(256).optional().default(""),
      author: z.string().max(300).optional().default(""),
      libraryId: z.string().optional().default(""),
      mediaType: z.enum(["book", "podcast"]).optional().default("book"),
    }),
  },
  responses: {
    200: {
      description: "Existing media id (null when absent)",
      content: { "application/json": { schema: MediaIdSchema } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const similarItemsRoute = {
  method: "get" as const,
  path: "/:id/similar",
  tags: ["items"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Similar items ordered by relevance",
      content: { "application/json": { schema: SimilarItemsSchema } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const itemCoverRoute = {
  method: "get" as const,
  path: "/:id/cover",
  tags: ["items"],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ force: z.string().optional() }),
  },
  responses: {
    302: { description: "Redirect to the cover URL" },
    404: {
      description: "No cover available",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    429: {
      description: "Metadata provider rate limit reached",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

const deleteItemCoverRoute = {
  method: "delete" as const,
  path: "/:id/cover",
  tags: ["items"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Cover deleted" },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
  },
};

const uploadItemCoverRoute = {
  method: "post" as const,
  path: "/:id/cover",
  tags: ["items"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "multipart/form-data": { schema: z.any() },
        "application/json": {
          schema: z.object({ url: z.string().optional() }),
        },
        "application/octet-stream": { schema: z.any() },
      },
    },
  },
  responses: {
    200: {
      description: "Cover uploaded",
      content: { "application/json": { schema: CoverUploadResultSchema } },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
  },
};

const deleteAudioFileRoute = {
  method: "delete" as const,
  path: "/:id/audio-files/:ino",
  tags: ["items"],
  request: { params: z.object({ id: z.string(), ino: z.string() }) },
  responses: {
    204: { description: "Audio file removed" },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    403: {
      description: "Forbidden",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    404: {
      description: "Item not found",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

const batchItemsRoute = {
  method: "post" as const,
  path: "/batch",
  tags: ["items"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ itemIds: z.array(z.string()).max(50).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Mapped items for the requested ids",
      content: { "application/json": { schema: BatchItemsSchema } },
    },
  },
};

const chapterAIRoute = {
  method: "post" as const,
  path: "/:id/chapters/ai",
  tags: ["items"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            author: z.string().optional(),
            chapterTitle: z.string().optional(),
            chapterIndex: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "AI-generated chapter insights",
      content: { "application/json": { schema: InsightsSchema } },
    },
    500: {
      description: "AI provider failure",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

const chapterAIGlobalRoute = {
  method: "post" as const,
  path: "/chapter-ai",
  tags: ["items"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            author: z.string().optional(),
            chapterTitle: z.string().optional(),
            chapterIndex: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "AI-generated chapter insights",
      content: { "application/json": { schema: InsightsSchema } },
    },
    500: {
      description: "AI provider failure",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

const syncCoversRoute = {
  method: "post" as const,
  path: "/sync-covers",
  tags: ["items"],
  responses: {
    200: {
      description: "Sync result",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Sync failure",
      content: { "application/json": { schema: SyncResultSchema } },
    },
  },
};

const syncDurationsRoute = {
  method: "post" as const,
  path: "/sync-durations",
  tags: ["items"],
  responses: {
    200: {
      description: "Sync result",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Sync failure",
      content: { "application/json": { schema: SyncResultSchema } },
    },
  },
};

const syncInsightsRoute = {
  method: "post" as const,
  path: "/sync-insights",
  tags: ["items"],
  responses: {
    200: {
      description: "Sync result",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Sync failure",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

// =========================
// Handlers
// =========================

itemsRouter.openapi(checkExistingRoute, async (c) => {
  const supabase = c.get("supabase");
  const { title, author, libraryId, mediaType } = c.req.valid("query");

  // Normalise helper — strips punctuation/spaces for fuzzy comparison
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedQuery = normalize(title);

  try {
    // 1. Exact title match (fast, uses index)
    let query = supabase
      .from("library_items")
      .select("id")
      .eq("library_id", libraryId)
      .eq("media_type", mediaType)
      .eq("title", title);

    if (mediaType === "book" && author) {
      query = query.eq("author_names_first_last", author);
    }

    const { data: exactMatch } = await query.limit(1).maybeSingle();
    if (exactMatch?.id) {
      return c.json({ mediaId: exactMatch.id }, 200);
    }

    // 2. Fuzzy fallback — use ilike to let the DB filter candidates so we
    //    don't load the entire library into memory. Pull at most 100 rows
    //    whose title shares the first 3 characters (covers most typos/subtitle
    //    variants without a full-table scan).
    const prefix = title.slice(0, 3);
    const { data: candidates } = await supabase
      .from("library_items")
      .select("id, title")
      .eq("library_id", libraryId)
      .eq("media_type", mediaType)
      .ilike("title", `${prefix}%`)
      .limit(100);

    if (candidates) {
      for (const book of candidates) {
        const normalizedBookTitle = normalize(book.title || "");
        if (!normalizedBookTitle || normalizedBookTitle.length <= 5) continue;

        if (normalizedBookTitle === normalizedQuery) {
          console.info(
            `[items] Fuzzy matched "${title}" to "${book.title}" (exact norm)`,
          );
          return c.json({ mediaId: book.id }, 200);
        }

        // Substring containment with a length-ratio guard to prevent broad false positives
        if (
          normalizedQuery.includes(normalizedBookTitle) ||
          normalizedBookTitle.includes(normalizedQuery)
        ) {
          const ratio =
            Math.min(normalizedBookTitle.length, normalizedQuery.length) /
            Math.max(normalizedBookTitle.length, normalizedQuery.length);
          if (ratio > FUZZY_MATCH_RATIO) {
            console.info(
              `[items] Fuzzy matched "${title}" to "${book.title}" (ratio ${
                ratio.toFixed(2)
              })`,
            );
            return c.json({ mediaId: book.id }, 200);
          }
        }
      }
    }

    // 3. Fallback to Z.AI Semantic Matching
    const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
      Deno.env.get("ZHIPU_API_KEY");
    if (zaiApiKey && title) {
      const { data: allLibItems } = await supabase
        .from("library_items")
        .select(
          "id, title, author_names_first_last, duration, size, library_files, audio_files",
        )
        .eq("library_id", libraryId)
        .eq("media_type", mediaType);

      if (allLibItems?.length) {
        const matchedId = await matchExistingBookWithZAI(
          title,
          author || "",
          allLibItems,
          zaiApiKey,
        );
        if (matchedId) {
          console.info(
            `[items] ZAI matched "${title}" to existing book ${matchedId}`,
          );
          return c.json({ mediaId: matchedId }, 200);
        }
      }
    }

    return c.json({ mediaId: null }, 200);
  } catch (err) {
    console.error("[items] check-existing failed:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

itemsRouter.openapi(similarItemsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: itemId } = c.req.valid("param");

  try {
    const { data, error } = await (supabase as unknown as Record<string, any>)
      .rpc("match_library_items", {
        item_id: itemId,
        match_threshold: SEARCH_MATCH_THRESHOLD,
        match_count: SEARCH_MATCH_COUNT,
      });

    if (error) {
      console.error("[items] Failed to fetch similar items:", error);
      return c.json({ error: "Failed to fetch similar items" }, 500);
    }

    if (!data || data.length === 0) {
      return c.json({ similarItems: [] }, 200);
    }

    const ids = ((data as { id: string }[]) || []).map((d) => d.id);

    const { data: items, error: itemsErr } = await supabase.from(
      "library_items",
    ).select("*").in("id", ids);

    if (itemsErr) {
      console.error("[items] Failed to fetch similar items details:", itemsErr);
      return c.json({ error: "Failed to fetch similar items details" }, 500);
    }

    const sortedItems = items?.sort((a: any, b: any) => {
      const indexA = ids.indexOf(a.id);
      const indexB = ids.indexOf(b.id);
      return indexA - indexB;
    }) || [];

    return c.json({ similarItems: sortedItems } as any, 200);
  } catch (err: any) {
    console.error("[items] similar items failed:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

itemsRouter.openapi(itemDetailRoute, async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const { id: itemId } = c.req.valid("param");

  console.info(`[handleItems] Fetching item ${itemId} for user ${user?.id}`);
  const { data: item, error } = await supabase.from("library_items").select(
    "*, book_authors(authors(*)), book_series(series(*))",
  ).eq("id", itemId).single();

  console.info(
    `[handleItems] Result for ${itemId}: data=${!!item}, error=`,
    error,
  );
  if (error) {
    return c.json(
      {
        error: typeof error === "string" ? error : error.message,
        details: error.details,
        hint: error.hint,
      },
      500,
    );
  }

  // Get progress
  const { data: progressData } = await supabase
    .from("media_progress")
    .select("*")
    .eq("user_id", user.id)
    .eq("library_item_id", item.id)
    .is("episode_id", null)
    .maybeSingle();

  return c.json(
    mapBookForMobile(
      item as unknown as LibraryItemWithBooks,
      progressData,
    ) as any,
    200,
  );
});

itemsRouter.openapi(itemCoverRoute, async (c): Promise<Response> => {
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const { id: itemId } = c.req.valid("param");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: item, error: _itemError } = await adminClient
    .from("library_items")
    .select("cover_path, title, book_authors(authors(name))")
    .eq("id", itemId)
    .single();

  let coverPath = item?.cover_path;
  const { force: forceParam } = c.req.valid("query");
  const force = forceParam === "1";

  // If cover is null, legacy invalid (starts with "/"), or we're forcing a retry
  if (
    !coverPath || coverPath.startsWith("/") ||
    (coverPath === "missing" && force)
  ) {
    const title = item?.title;
    const bookAuthors = item?.book_authors || [];
    const authorArray = Array.isArray(bookAuthors)
      ? bookAuthors
      : [bookAuthors];
    const authorsObj = authorArray[0]?.authors as { name: string } | {
      name: string;
    }[];
    const firstAuthorName = ((Array.isArray(authorsObj)
      ? authorsObj[0]?.name
      : authorsObj?.name) as string) || "";
    const author = firstAuthorName;

    if (title) {
      try {
        const { fetchBookMetadata } = await import(
          "../../_shared/coverFetch.ts"
        );
        const fetchRes = await fetchBookMetadata(title, author);
        if (fetchRes?.cover?.buffer) {
          const fileData = new Uint8Array(fetchRes.cover.buffer);
          const ext = fetchRes.cover.extension || "jpg";
          coverPath = `${itemId}/cover.${ext}`;
          const contentType = `image/${ext === "png" ? "png" : "jpeg"}`;

          const { error: uploadError } = await adminClient.storage.from(
            "covers",
          ).upload(coverPath, fileData, { upsert: true, contentType });
          if (uploadError) {
            console.error(
              `[items] Cover upload failed for ${itemId}:`,
              uploadError,
            );
            throw new Error("UploadFailed");
          }

          await adminClient
            .from("library_items")
            .update({ cover_path: coverPath })
            .eq("id", itemId);
        } else {
          // Metadata fetch succeeded but no cover image — persist "missing" to
          // avoid re-fetching on every subsequent request.
          coverPath = "missing";
          await adminClient
            .from("library_items")
            .update({ cover_path: "missing" })
            .eq("id", itemId);
        }
      } catch (e) {
        console.error(`[items] Dynamic cover fetch failed for ${title}:`, e);
        if (e instanceof Error && e.message === "RateLimitExceeded") {
          // Do NOT persist "missing" on rate-limit — the failure is temporary.
          // Tell the client to back off and retry.
          return c.json(
            { error: "Rate limit exceeded while fetching cover" },
            429,
          );
        }
        // Any other error (network, upload failure, etc.) — persist "missing"
        // so we don't hammer the metadata provider on every page load.
        coverPath = "missing";
        await adminClient
          .from("library_items")
          .update({ cover_path: "missing" })
          .eq("id", itemId);
      }
    } else {
      // No title — can't attempt a fetch; mark missing immediately.
      coverPath = "missing";
      await adminClient.from("library_items").update({ cover_path: "missing" })
        .eq("id", itemId);
    }
  }

  if (!coverPath || coverPath === "missing" || coverPath.startsWith("/")) {
    return c.json({ error: "Not found" }, 404);
  }

  const { data } = adminClient.storage.from("covers").getPublicUrl(coverPath);
  let publicUrl = data.publicUrl;

  if (
    publicUrl.includes(["127", "0", "0", "1"].join(".")) ||
    publicUrl.includes(["local", "host"].join("")) ||
    publicUrl.includes("host.docker.internal")
  ) {
    const origin = getProxyOrigin(c);
    try {
      const urlObj = new URL(publicUrl);
      publicUrl = `${origin}${urlObj.pathname}`;
    } catch (_e) {
      // Ignore URL parse errors
    }
  }

  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.redirect(publicUrl, 302);
});

itemsRouter.openapi(deleteItemCoverRoute, async (c): Promise<Response> => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const { id: itemId } = c.req.valid("param");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: item } = await adminClient.from("library_items").select(
    "cover_path",
  ).eq("id", itemId).single();
  if (item?.cover_path) {
    await adminClient.storage.from("covers").remove([item.cover_path]);
  }
  await adminClient.from("library_items").update({ cover_path: null }).eq(
    "id",
    itemId,
  );
  return new Response(null, { status: 204 });
});

const handleCoverUpload = async (
  c: Context<{ Variables: Variables }>,
) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const itemId = c.req.param("id");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  let fileData: ArrayBuffer | null = null;
  let extension = "jpg";
  let contentType = "image/jpeg";

  const contentTypeHeader = c.req.header("content-type") || "";

  if (contentTypeHeader.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("cover") as File;
    if (file) {
      fileData = await file.arrayBuffer();
      extension = file.name.split(".").pop() || "jpg";
      contentType = file.type || "image/jpeg";
    }
  } else if (contentTypeHeader.includes("application/json")) {
    const body = await c.req.json();
    if (body.url) {
      let isValidUrl = false;
      try {
        const parsedUrl = new URL(body.url);
        isValidUrl = parsedUrl.protocol === "http:" ||
          parsedUrl.protocol === "https:";
      } catch {
        isValidUrl = false;
      }
      if (!isValidUrl) {
        return c.json({ error: "Invalid URL scheme" }, 400);
      }

      const res = await fetch(body.url);
      if (res.ok) {
        fileData = await res.arrayBuffer();
        contentType = res.headers.get("content-type") || "image/jpeg";
        extension = contentType.split("/")[1]?.split("+")[0] || "jpg";
      }
    }
  } else {
    fileData = await c.req.arrayBuffer();
  }

  if (!fileData || fileData.byteLength === 0) {
    return c.json({ error: "No file provided" }, 400);
  }

  const storagePath = `${itemId}/cover.${extension}`;
  const { error: uploadError } = await adminClient.storage.from("covers")
    .upload(storagePath, fileData, { upsert: true, contentType });

  if (uploadError) throw uploadError;

  await adminClient.from("library_items").update({ cover_path: storagePath })
    .eq("id", itemId);

  return c.json({ updated: true }, 200);
};

const uploadItemCoverPatchRoute = {
  ...uploadItemCoverRoute,
  method: "patch" as const,
};
itemsRouter.openapi(uploadItemCoverRoute, handleCoverUpload);
itemsRouter.openapi(uploadItemCoverPatchRoute, handleCoverUpload);

itemsRouter.openapi(deleteAudioFileRoute, async (c): Promise<Response> => {
  const user = c.get("user")!;
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const supabase = c.get("supabase");
  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin" && profile?.user_type !== "root") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const { id: itemId, ino: fileIno } = c.req.valid("param");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: item } = await adminClient.from("library_items").select(
    "audio_files",
  ).eq("id", itemId).single();
  if (!item) return c.json({ error: "Not found" }, 404);

  const audioFiles =
    (item?.audio_files as { ino: string; metadata: { path: string } }[]) || [];
  const fileToDelete = audioFiles.find((f) => f.ino === fileIno);

  if (fileToDelete?.metadata?.path) {
    await adminClient.storage.from("audio-files").remove([
      fileToDelete.metadata.path,
    ]);
  }

  const updatedFiles = audioFiles.filter((f) => f.ino !== fileIno);
  await adminClient.from("library_items").update({ audio_files: updatedFiles })
    .eq("id", itemId);

  return new Response(null, { status: 204 });
});

itemsRouter.openapi(batchItemsRoute, async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const body = await c.req.json().catch(() => ({}));
  const itemIds: string[] = Array.isArray(body.itemIds)
    ? body.itemIds.slice(0, 50)
    : [];

  if (itemIds.length === 0) {
    return c.json({ items: [] }, 200);
  }

  const { data: items, error } = await supabase.from("library_items").select(
    "*, book_authors(authors(*)), book_series(series(*))",
  ).in("id", itemIds);

  if (error || !items) {
    return c.json({ items: [] }, 200);
  }

  const { data: progressData } = await supabase.from("media_progress").select(
    "*",
  ).eq("user_id", user.id).in("library_item_id", itemIds).is(
    "episode_id",
    null,
  );

  const progressMap = new Map(
    (progressData || []).map((p) => [p.library_item_id, p]),
  );

  const mappedItems = items.map((item) =>
    mapBookForMobile(
      item as unknown as LibraryItemWithBooks,
      progressMap.get(item.id),
    )
  );

  c.header("Cache-Control", "private, max-age=30");
  return c.json({ items: mappedItems } as any, 200);
});

export async function handleChapterAI(
  c: Context<{ Variables: Variables }>,
) {
  const body = await c.req.json().catch(() => ({}));
  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";
  if (!zaiApiKey) {
    return c.json({
      error: "ZAI_API_KEY (or ZHIPU_API_KEY) is not configured on the server",
    }, 500);
  }
  const { title, author, chapterTitle, chapterIndex } = body;
  try {
    const insights = await generateChapterAIInsights(
      title || "",
      author || "Unknown Author",
      chapterTitle || "",
      chapterIndex,
      zaiApiKey,
    );
    return c.json({ insights } as any, 200);
  } catch (e: unknown) {
    return c.json({
      error: getErrorMessage(e),
    }, 500);
  }
}

itemsRouter.openapi(chapterAIRoute, handleChapterAI);
itemsRouter.openapi(chapterAIGlobalRoute, handleChapterAI);

async function handleSyncCovers(
  c: Context<{ Variables: Variables }>,
) {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  try {
    const url = new URL(c.req.url);
    const limitParam = parseInt(url.searchParams.get("limit") || "5", 10);
    const limit = Math.min(Math.max(limitParam, 1), 20);

    const { data: items, error: itemsError } = await supabase
      .from("library_items")
      .select(
        "id, cover_path, title, author_names_first_last, author_names_last_first",
      )
      .or("cover_path.is.null,cover_path.like./%")
      .limit(limit);

    if (itemsError) throw itemsError;

    let updatedCount = 0;
    for (const item of items || []) {
      const title = item.title || "";
      const author = item.author_names_first_last ||
        item.author_names_last_first || "";
      if (item.cover_path && !item.cover_path.startsWith("/")) continue;
      if (title) {
        const fetchRes = await fetchBookMetadata(title, author);
        if (fetchRes && fetchRes.cover && fetchRes.cover.buffer) {
          const fileData = new Uint8Array(fetchRes.cover.buffer);
          const ext = fetchRes.cover.extension || "jpg";
          const storagePath = `${item.id}/cover.${ext}`;
          const { error: upErr } = await supabase.storage.from("covers").upload(
            storagePath,
            fileData,
            {
              contentType: `image/${ext === "png" ? "png" : "jpeg"}`,
              upsert: true,
            },
          );
          if (!upErr) {
            await supabase.from("library_items").update({
              cover_path: storagePath,
            }).eq("id", item.id);
            updatedCount++;
          }
        }
      }
    }

    return c.json({
      success: true,
      updated: updatedCount,
      message: `Updated covers for ${updatedCount} books`,
    }, 200);
  } catch (e: unknown) {
    return c.json(
      { success: false, error: getErrorMessage(e) },
      500,
    );
  }
}

async function handleSyncDurations(
  c: Context<{ Variables: Variables }>,
) {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  try {
    const { data: items, error } = await supabase
      .from("library_items")
      .select("id, audio_files")
      .or("duration.is.null,duration.eq.0");

    if (error) throw error;

    let updatedCount = 0;
    for (const item of items || []) {
      const files = (item.audio_files as { duration?: number }[]) || [];
      const totalDuration = files.reduce(
        (acc, f) => acc + (f.duration || 0),
        0,
      );
      if (totalDuration > 0) {
        await supabase
          .from("library_items")
          .update({ duration: Math.round(totalDuration) })
          .eq("id", item.id);
        updatedCount++;
      }
    }

    return c.json({
      success: true,
      updated: updatedCount,
      message: `Updated duration for ${updatedCount} items`,
    }, 200);
  } catch (e: unknown) {
    return c.json({
      success: false,
      error: getErrorMessage(e),
    }, 500);
  }
}

async function handleSyncBookInsights(
  c: Context<{ Variables: Variables }>,
) {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  try {
    const url = new URL(c.req.url);
    const limitParam = parseInt(url.searchParams.get("limit") || "5", 10);
    const limit = Math.min(Math.max(limitParam, 1), 20);

    const { data: items, error: itemsError } = await supabase
      .from("library_items")
      .select("id, title, author_names_first_last, author_names_last_first")
      .limit(limit);

    if (itemsError) throw itemsError;

    let processedCount = 0;
    for (const item of items || []) {
      const title = item.title || "";
      const author = item.author_names_first_last ||
        item.author_names_last_first || null;
      if (title) {
        await ensureBookAIInsights(supabase, item.id, title, author);
        processedCount++;
      }
    }

    return c.json({
      success: true,
      processed: processedCount,
      message: `Processed AI insights for ${processedCount} books`,
    }, 200);
  } catch (e: unknown) {
    return c.json({ error: getErrorMessage(e) }, 500);
  }
}

const syncCoversGetRoute = {
  ...syncCoversRoute,
  method: "get" as const,
};
const syncDurationsGetRoute = {
  ...syncDurationsRoute,
  method: "get" as const,
};
const syncInsightsGetRoute = {
  ...syncInsightsRoute,
  method: "get" as const,
};

itemsRouter.openapi(syncCoversRoute, handleSyncCovers);
itemsRouter.openapi(syncDurationsRoute, handleSyncDurations);
itemsRouter.openapi(syncInsightsRoute, handleSyncBookInsights);
itemsRouter.openapi(syncCoversGetRoute, handleSyncCovers);
itemsRouter.openapi(syncDurationsGetRoute, handleSyncDurations);
itemsRouter.openapi(syncInsightsGetRoute, handleSyncBookInsights);
