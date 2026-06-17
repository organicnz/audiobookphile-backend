import { Context, Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
import { mapBookForMobile } from "../mappers.ts";
import { Variables } from "../_shared/types.ts";
import { getProxyOrigin } from "../_shared/proxy.ts";

export const itemsRouter = new Hono<{ Variables: Variables }>();

itemsRouter.get("/check-existing", async (c) => {
  const supabase = c.get("supabase");
  const title = c.req.query("title") || "";
  const author = c.req.query("author") || "";
  const libraryId = c.req.query("libraryId") || "";
  const mediaType = c.req.query("mediaType") || "book";

  try {
    let query = supabase
      .from("library_items")
      .select("media_id")
      .eq("library_id", libraryId)
      .eq("media_type", mediaType)
      .eq("title", title);

    if (mediaType === "book" && author) {
      // For books, also try to match the exact author
      query = query.eq("author_names_first_last", author);
    }

    const { data } = await query.limit(1).maybeSingle();
    if (data?.media_id) {
      return c.json({ mediaId: data.media_id });
    }

    // Fuzzy match fallback
    const { data: allBooks } = await supabase
      .from("library_items")
      .select("media_id, title")
      .eq("library_id", libraryId)
      .eq("media_type", mediaType);

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

itemsRouter.get("/:id", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const itemId = c.req.param("id");

  console.log(`[handleItems] Fetching item ${itemId} for user ${user?.id}`);
  const { data: item, error } = await supabase
    .from("library_items")
    .select("*, books(*, book_authors(authors(*)), book_series(series(*)))")
    .eq("id", itemId)
    .single();

  console.log(
    `[handleItems] Result for ${itemId}: data=${!!item}, error=`,
    error,
  );
  if (error) {
    return c.json({
      error: error.message || error,
      details: error.details,
      hint: error.hint,
    }, 500);
  }

  // Get progress
  const { data: progressData } = await supabase.from("media_progress").select(
    "*",
  ).eq("user_id", user.id).eq("library_item_id", item.id).is("episode_id", null)
    .maybeSingle();

  return c.json(mapBookForMobile(item, progressData));
});

itemsRouter.get("/:id/cover", async (c) => {
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const itemId = c.req.param("id");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: item, error: _itemError } = await adminClient.from(
    "library_items",
  ).select("cover_path, books(title, book_authors(authors(name)))").eq(
    "id",
    itemId,
  ).single();

  let coverPath = item?.cover_path;

  // Self-healing: if it was previously cached as "missing" due to rate-limit swallowing,
  // reset it so we can retry the fetch now that the bug is fixed.
  if (coverPath === "missing") {
    coverPath = null;
    await adminClient.from("library_items").update({ cover_path: null }).eq(
      "id",
      itemId,
    );
  }

  // If missing or legacy invalid, fetch dynamically
  if (!coverPath || coverPath === "missing" || coverPath.startsWith("/")) {
    const book = Array.isArray(item?.books) ? item?.books[0] : item?.books;
    const title = book?.title;
    const bookAuthors = book?.book_authors || [];
    const authorArray = Array.isArray(bookAuthors)
      ? bookAuthors
      : [bookAuthors];
    const firstAuthorName =
      (authorArray[0]?.authors as Record<string, unknown>)?.name as string ||
      "";
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
          ).upload(
            coverPath,
            fileData,
            { upsert: true, contentType },
          );
          if (uploadError) {
            console.error(
              `[items] Cover upload failed for ${itemId}:`,
              uploadError,
            );
            throw new Error("UploadFailed");
          }

          await adminClient.from("library_items").update({
            cover_path: coverPath,
          }).eq("id", itemId);
        } else {
          coverPath = "missing";
          await adminClient.from("library_items").update({
            cover_path: "missing",
          }).eq("id", itemId);
        }
      } catch (e) {
        console.error(`[items] Dynamic cover fetch failed for ${title}:`, e);
        if (e instanceof Error && e.message === "RateLimitExceeded") {
          // Do NOT cache 'missing' if we hit a rate limit, so we can retry later.
          // Tell the client to back off.
          return new Response("Rate limit exceeded while fetching cover", {
            status: 429,
          });
        } else {
          coverPath = "missing";
          await adminClient.from("library_items").update({
            cover_path: "missing",
          }).eq("id", itemId);
        }
      }
    } else {
      coverPath = "missing";
      await adminClient.from("library_items").update({ cover_path: "missing" })
        .eq("id", itemId);
    }
  }

  if (!coverPath || coverPath === "missing" || coverPath.startsWith("/")) {
    // Intercept missing covers for mobile clients (which request a specific format)
    // and serve a fallback image so older TestFlight builds don't show a blurred empty box.
    // We leave the 404 intact for the web client so it can render its text-based UI placeholder.
    if (c.req.query("format")) {
      const origin = getProxyOrigin(c);
      const fallbackUrl = `${origin}/images/book_placeholder.jpg`;
      return c.redirect(fallbackUrl, 302);
    }

    return new Response("Not found", { status: 404 });
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

  return c.redirect(publicUrl, 302);
});

itemsRouter.delete("/:id/cover", async (c) => {
  const user = c.get("user")!;
  if (!user) return new Response("Unauthorized", { status: 401 });

  const supabase = c.get("supabase");
  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

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
  const user = c.get("user")!;
  if (!user) return new Response("Unauthorized", { status: 401 });

  const supabase = c.get("supabase");
  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return new Response("Forbidden", { status: 403 });
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
        return new Response("Invalid URL scheme", { status: 400 });
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
    return new Response("No file provided", { status: 400 });
  }

  const storagePath = `${itemId}/cover.${extension}`;
  const { error: uploadError } = await adminClient.storage
    .from("covers")
    .upload(storagePath, fileData, { upsert: true, contentType });

  if (uploadError) throw uploadError;

  await adminClient.from("library_items").update({ cover_path: storagePath })
    .eq("id", itemId);

  return c.json({ updated: true });
};

itemsRouter.post("/:id/cover", handleCoverUpload);
itemsRouter.patch("/:id/cover", handleCoverUpload);
