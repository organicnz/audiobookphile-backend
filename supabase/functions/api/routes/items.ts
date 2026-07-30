import { Context, Hono } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { mapBookForMobile } from "../../api/mappers.ts";
import { Variables } from "../_shared/types.ts";
import { getProxyOrigin } from "../../api/_shared/proxy.ts";
import { generateChapterAIInsights } from "../../_shared/zai.ts";
import { fetchBookMetadata } from "../../_shared/coverFetch.ts";

export const itemsRouter = new Hono<{ Variables: Variables }>();

itemsRouter.get("/check-existing", async (c) => {
  const supabase = c.get("supabase");
  const title = c.req.query("title") || "";
  const author = c.req.query("author") || "";
  const libraryId = c.req.query("libraryId") || "";
  const mediaType = c.req.query("mediaType") || "book";

  try {
    let query = supabase.from("library_items").select("media_id").eq(
      "library_id",
      libraryId,
    ).eq("media_type", mediaType).eq("title", title);

    if (mediaType === "book" && author) {
      // For books, also try to match the exact author
      query = query.eq("author_names_first_last", author);
    }

    const { data } = await query.limit(1).maybeSingle();
    if (data?.media_id) {
      return c.json({ mediaId: data.media_id });
    }

    // Fuzzy match fallback
    const { data: allBooks } = await supabase.from("library_items").select(
      "media_id, title",
    ).eq("library_id", libraryId).eq("media_type", mediaType);

    if (allBooks) {
      const normalize = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedQuery = normalize(title);

      for (const book of allBooks) {
        const normalizedBookTitle = normalize(book.title || "");
        if (!normalizedBookTitle) continue;

        if (normalizedBookTitle === normalizedQuery) {
          console.log(
            `[items] Fuzzy matched "${title}" to existing book "${book.title}" (exact norm)`,
          );
          return c.json({ mediaId: book.media_id });
        }

        if (normalizedBookTitle.length > 5) {
          if (
            normalizedQuery.includes(normalizedBookTitle) ||
            normalizedBookTitle.includes(normalizedQuery)
          ) {
            const ratio1 = normalizedBookTitle.length / normalizedQuery.length;
            const ratio2 = normalizedQuery.length / normalizedBookTitle.length;
            if (ratio1 > 0.5 || ratio2 > 0.5) {
              console.log(
                `[items] Fuzzy matched "${title}" to existing book "${book.title}" (ratio)`,
              );
              return c.json({ mediaId: book.media_id });
            }
          }
        }
      }
    }

    return c.json({ mediaId: null });
  } catch (err) {
    console.error("[items] check-existing failed:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

itemsRouter.get("/:id/similar", async (c) => {
  const supabase = c.get("supabase");
  const itemId = c.req.param("id");

  try {
    const { data, error } = await (supabase as any).rpc("match_library_items", {
      item_id: itemId,
      match_threshold: 0.2,
      match_count: 10,
    });

    if (error) {
      console.error("[items] Failed to fetch similar items:", error);
      return c.json({ error: "Failed to fetch similar items" }, 500);
    }

    if (!data || data.length === 0) {
      return c.json({ similarItems: [] });
    }

    const ids = data.map((d: any) => d.id);

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

    return c.json({ similarItems: sortedItems });
  } catch (err: any) {
    console.error("[items] similar items failed:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

itemsRouter.get("/:id", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const itemId = c.req.param("id");

  console.log(`[handleItems] Fetching item ${itemId} for user ${user?.id}`);
  const { data: item, error } = await supabase.from("library_items").select(
    "*, book_authors(authors(*)), book_series(series(*))",
  ).eq("id", itemId).single();

  console.log(
    `[handleItems] Result for ${itemId}: data=${!!item}, error=`,
    error,
  );
  if (error) {
    return c.json(
      {
        error: error.message || error,
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

  return c.json(mapBookForMobile(item, progressData));
});

itemsRouter.get("/:id/cover", async (c) => {
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const itemId = c.req.param("id");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: item, error: _itemError } = await adminClient
    .from("library_items")
    .select("cover_path, title, book_authors(authors(name))")
    .eq("id", itemId)
    .single();

  let coverPath = item?.cover_path;
  const force = c.req.query("force") === "1";

  // If cover is null, legacy invalid, or we force a retry
  if (
    !coverPath || coverPath.startsWith("/") ||
    (coverPath === "missing" && force)
  ) {
    const title = item?.title;
    const bookAuthors = item?.book_authors || [];
    const authorArray = Array.isArray(bookAuthors)
      ? bookAuthors
      : [bookAuthors];
    const authorsObj = authorArray[0]?.authors as any;
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
            .update({
              cover_path: coverPath,
            })
            .eq("id", itemId);
        } else {
          coverPath = "missing";
          await adminClient
            .from("library_items")
            .update({
              cover_path: "missing",
            })
            .eq("id", itemId);
        }
      } catch (e) {
        console.error(`[items] Dynamic cover fetch failed for ${title}:`, e);
        if (e instanceof Error && e.message === "RateLimitExceeded") {
          // Do NOT cache 'missing' if we hit a rate limit, so we can retry later.
          // Tell the client to back off.
          return c.json(
            { error: "Rate limit exceeded while fetching cover" },
            429,
          );
        } else {
          coverPath = "missing";
          await adminClient
            .from("library_items")
            .update({
              cover_path: "missing",
            })
            .eq("id", itemId);
        }
      }
    } else {
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
    publicUrl.includes("127.0.0.1") || publicUrl.includes("localhost") ||
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

itemsRouter.delete("/:id/cover", async (c) => {
  const _user = c.get("user")!;
  const _requiresServiceRole = true;

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const itemId = c.req.param("id");

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

const handleCoverUpload = async (c: Context) => {
  const _user = c.get("user")!;
  const supabase = c.get("supabase");

  const _requiresServiceRole = true;

  const { data: _profile } = await supabase.from("profiles").select("user_type")
    .eq("id", _user.id).single();

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

  return c.json({ updated: true });
};

itemsRouter.post("/:id/cover", handleCoverUpload);
itemsRouter.patch("/:id/cover", handleCoverUpload);

itemsRouter.delete("/:id/audio-files/:ino", async (c) => {
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
  const itemId = c.req.param("id");
  const fileIno = c.req.param("ino");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: item } = await adminClient.from("library_items").select(
    "audio_files",
  ).eq("id", itemId).single();
  if (!item) return c.json({ error: "Not found" }, 404);

  const audioFiles = (item?.audio_files as any[]) || [];
  const fileToDelete = audioFiles.find((f: any) => f.ino === fileIno);

  if (fileToDelete?.metadata?.path) {
    await adminClient.storage.from("audio-files").remove([
      fileToDelete.metadata.path,
    ]);
  }

  const updatedFiles = audioFiles.filter((f: any) => f.ino !== fileIno);
  await adminClient.from("library_items").update({ audio_files: updatedFiles })
    .eq("id", itemId);

  return new Response(null, { status: 204 });
});

itemsRouter.post("/batch", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const body = await c.req.json().catch(() => ({}));
  const itemIds: string[] = Array.isArray(body.itemIds)
    ? body.itemIds.slice(0, 50)
    : [];

  if (itemIds.length === 0) {
    return c.json({ items: [] });
  }

  const { data: items, error } = await supabase.from("library_items").select(
    "*, book_authors(authors(*)), book_series(series(*))",
  ).in("id", itemIds);

  if (error || !items) {
    return c.json({ items: [] });
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
    mapBookForMobile(item as any, progressMap.get(item.id))
  );

  c.header("Cache-Control", "private, max-age=30");
  return c.json({ items: mappedItems });
});

async function handleChapterAI(c: any) {
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
    return c.json({ insights });
  } catch (e: any) {
    return c.json({
      error: e.message || "Failed to generate chapter AI insights",
    }, 500);
  }
}

itemsRouter.post("/items/:id/chapters/ai", handleChapterAI);
itemsRouter.post("/chapter-ai", handleChapterAI);

async function handleSyncCovers(c: any) {
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
      updatedCount,
      totalChecked: (items || []).length,
    });
  } catch (e: any) {
    return c.json(
      { success: false, error: e.message || "Sync covers failed" },
      500,
    );
  }
}

async function handleSyncDurations(c: any) {
  const supabase = c.get("supabase");
  try {
    const url = new URL(c.req.url);
    const bookId = url.searchParams.get("bookId");
    let query = supabase.from("library_items").select("*");
    if (bookId) query = query.eq("id", bookId);
    const { data: books, error } = await query;
    if (error) throw error;

    let updatedCount = 0;
    for (const book of books || []) {
      if (!book.audio_files) continue;
      let files = book.audio_files as any[];
      let _changed = false;
      let newTotalDuration = 0;
      for (const f of files) {
        let dur = f.duration || f.metadata?.duration || 0;
        newTotalDuration += dur;
      }
      if (newTotalDuration > 0 && newTotalDuration !== book.duration) {
        await supabase.from("library_items").update({
          duration: newTotalDuration,
        }).eq("id", book.id);
        updatedCount++;
      }
    }
    return c.json({ success: true, updatedCount });
  } catch (e: any) {
    return c.json({
      success: false,
      error: e.message || "Sync durations failed",
    }, 500);
  }
}

itemsRouter.post("/sync-covers", handleSyncCovers);
itemsRouter.post("/sync-durations", handleSyncDurations);
itemsRouter.get("/sync-covers", handleSyncCovers);
itemsRouter.get("/sync-durations", handleSyncDurations);
