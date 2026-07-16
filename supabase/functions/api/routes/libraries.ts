import { Hono } from "hono";
import { mapBookForMobile, mapLibraryForMobile } from "../mappers.ts";
import { Database } from "../../../../src/types/supabase.ts";
import { z } from "zod";
import { Variables } from "../_shared/types.ts";

export const librariesRouter = new Hono<{ Variables: Variables }>();

type LibraryWithFolders = Database["public"]["Tables"]["libraries"]["Row"] & {
  library_folders: Database["public"]["Tables"]["library_folders"]["Row"][];
};

librariesRouter.get("/", async (c) => {
  const supabase = c.get("supabase");
  const { data: libraries, error } = await supabase.from("libraries").select(
    "*, library_folders(*)",
  ).order("display_order");
  if (error) throw error;
  const formatted = libraries.map((l: any) =>
    mapLibraryForMobile(l as unknown as LibraryWithFolders)
  );
  return c.json({ libraries: formatted });
});

librariesRouter.post("/", async (c) => {
  const supabase = c.get("supabase");
  const rawBody = await c.req.json();
  const LibraryCreatePayload = z.object({
    name: z.string(),
    mediaType: z.string().optional(),
    provider: z.string().optional(),
    folders: z.array(z.object({ fullPath: z.string() })).optional(),
  });

  const parsed = LibraryCreatePayload.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", details: parsed.error.issues },
      400,
    );
  }
  const body = parsed.data;

  const { data: libraries } = await supabase.from("libraries").select("id");
  const display_order = libraries ? libraries.length + 1 : 1;

  const { data, error } = await supabase.from("libraries").insert(
    {
      id: crypto.randomUUID(),
      name: body.name,
      media_type: body.mediaType,
      provider: body.provider || "default",
      display_order,
    } as any,
  ).select().single();

  if (error) throw error;

  if (body.folders && body.folders.length > 0) {
    const folders = body.folders.map((f: Record<string, unknown>) => ({
      library_id: data.id,
      full_path: String(f.fullPath || ""),
    }));
    await supabase.from("library_folders").insert(folders as any);
  }

  const { data: fullLibrary } = await supabase.from("libraries").select(
    "*, library_folders(*)",
  ).eq("id", data.id).single();
  return c.json(mapLibraryForMobile((fullLibrary || {}) as any));
});

librariesRouter.patch("/:id", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const rawBody = await c.req.json();

  const LibraryUpdatePayload = z.object({
    name: z.string().optional(),
    displayOrder: z.number().optional(),
    folders: z.array(
      z.object({ fullPath: z.string().optional(), id: z.string().optional() }),
    ).optional(),
  });

  const parsed = LibraryUpdatePayload.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", details: parsed.error.issues },
      400,
    );
  }
  const body = parsed.data;

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.displayOrder !== undefined) {
    updates.display_order = body.displayOrder;
  }
  // etc

  const { error } = await supabase.from("libraries").update(updates as any).eq(
    "id",
    libraryId,
  );
  if (error) throw error;

  if (body.folders) {
    await supabase.from("library_folders").delete().eq("library_id", libraryId);
    if (body.folders.length > 0) {
      const folders = body.folders.map((f: Record<string, unknown>) => ({
        library_id: libraryId,
        full_path: String(f.fullPath || f.id),
      }));
      await supabase.from("library_folders").insert(folders as any);
    }
  }

  const { data: fullLibrary } = await supabase.from("libraries").select(
    "*, library_folders(*)",
  ).eq("id", libraryId).single();
  return c.json(mapLibraryForMobile((fullLibrary || {}) as any));
});

librariesRouter.delete("/:id", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const { error } = await supabase.from("libraries").delete().eq(
    "id",
    libraryId,
  );
  if (error) throw error;
  return c.json({ success: true });
});

librariesRouter.get("/:id/items", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");

  const queryParams = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(queryParams.get("limit") || "50", 10);
  const page = parseInt(queryParams.get("page") || "0", 10);
  const sort = queryParams.get("sort") || "addedAt";
  const desc = queryParams.get("desc") !== "0";
  const offset = page * limit;

  const dbSortField = sort === "addedAt"
    ? "created_at"
    : (sort === "media.metadata.title" ? "title" : "created_at");

  try {
    const { data: items, error, count } = await supabase
      .from("library_items")
      .select("*, books(*, book_authors(authors(*)), book_series(series(*)))", {
        count: "exact",
      })
      .eq("library_id", libraryId)
      .order(dbSortField, { ascending: !desc })
      .range(offset, offset + limit - 1);

    if (error) {
      return c.json({
        error: error.message || error,
        details: error.details,
        hint: error.hint,
      }, 500);
    }

    const itemIds = items.map((i) => i.id);
    let progressMap = new Map();
    if (itemIds.length > 0) {
      const { data: progressData } = await supabase.from("media_progress")
        .select("*").eq("user_id", (user as any).id).in(
          "library_item_id",
          itemIds,
        ).is("episode_id", null);
      progressMap = new Map(
        (progressData || []).map((p: any) => [p.library_item_id, p]),
      );
    }

    const mappedItems = items.map((i: any) =>
      mapBookForMobile(i, progressMap.get(i.id) as any)
    );

    const response = {
      results: mappedItems,
      total: count || 0,
      limit,
      page: offset / limit,
      sortBy: sort,
      sortDesc: desc,
    };

    return c.json(response);
  } catch (e: unknown) {
    const err = e as Error;
    return c.json({
      error: "Exception",
      message: err.message,
      stack: err.stack,
    }, 500);
  }
});

librariesRouter.get("/:id/search", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const q = new URL(c.req.raw.url).searchParams.get("q") || "";
  const limit = parseInt(
    new URL(c.req.raw.url).searchParams.get("limit") || "12",
    10,
  );

  const { data: items, error } = await supabase
    .from("library_items")
    .select("*, books(*, book_authors(authors(*)), book_series(series(*)))")
    .eq("library_id", libraryId)
    .ilike("title", `%${q}%`)
    .limit(limit);

  if (error) throw error;

  const user = c.get("user");
  const itemIds = (items || []).map((i) => i.id);
  let progressMap = new Map();
  if (user && itemIds.length > 0) {
    const { data: progressData } = await supabase.from("media_progress")
      .select("*")
      .eq("user_id", user.id)
      .in("library_item_id", itemIds)
      .is("episode_id", null);
    progressMap = new Map(
      (progressData || []).map((p: any) => [p.library_item_id, p]),
    );
  }

  const results = items.map((item: any) => ({
    libraryItem: mapBookForMobile(item, progressMap.get(item.id) as any),
    matchKey: "title",
    matchText: item.title || "",
  }));

  return c.json({ results });
});

librariesRouter.get("/:id/filterdata", (c) => {
  const emptyFilterData = {
    authors: [],
    genres: [],
    tags: [],
    series: [],
    narrators: [],
    languages: [],
  };
  return c.json(emptyFilterData);
});

librariesRouter.get("/:id/matchall", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");

  const processAllChunks = async (startOffset: number) => {
    let offset = startOffset;
    const limit = 10;
    try {
      const { fetchBookMetadata } = await import("../../_shared/coverFetch.ts");

      while (true) {
        const { data: items, error } = await supabase
          .from("library_items")
          .select("id, title, books(book_authors(authors(name)))")
          .eq("library_id", libraryId)
          .range(offset, offset + limit - 1)
          .order("id");

        if (error || !items || items.length === 0) break;

        for (const item of items) {
          const bookItem = Array.isArray(item.books)
            ? item.books[0]
            : item.books;
          const bookAuthors =
            ((bookItem as Record<string, unknown>)?.book_authors as Record<
              string,
              unknown
            >[]) || [];
          const authorData = bookAuthors[0]?.authors as
            | Record<string, unknown>
            | undefined;
          const authorName = authorData?.name
            ? String(authorData.name || "")
            : "";
          const result = await fetchBookMetadata(item.title || "", authorName);

          if (result && result.metadata) {
            const updates: Record<string, unknown> = {};
            if (result.metadata.description) {
              updates.description = result.metadata.description;
            }
            if (result.metadata.publishedYear) {
              updates.published_year = result.metadata.publishedYear;
            }
            if (result.metadata.publisher) {
              updates.publisher = result.metadata.publisher;
            }
            if (result.metadata.language) {
              updates.language = result.metadata.language;
            }
            if (result.metadata.genres) updates.genres = result.metadata.genres;

            if (Object.keys(updates).length > 0) {
              await supabase.from("library_items").update(updates as any).eq(
                "id",
                item.id,
              );
            }

            if (result.cover) {
              const storagePath = `${item.id}/cover.${result.cover.extension}`;
              await supabase.storage.from("covers").upload(
                storagePath,
                result.cover.buffer,
                { upsert: true, contentType: result.cover.contentType },
              );
              await supabase.from("library_items").update({
                cover_path: storagePath,
              }).eq("id", item.id);
            }
          }
        }
        offset += limit;
      }
    } catch (err) {
      console.error(`[libraries] matchAll background task failed:`, err);
    }
  };

  // @ts-ignore
  if (
    typeof (globalThis as any).EdgeRuntime !== "undefined" &&
    typeof (globalThis as any).EdgeRuntime.waitUntil === "function"
  ) {
    // @ts-ignore
    (globalThis as any).EdgeRuntime.waitUntil(processAllChunks(0));
  } else {
    processAllChunks(0).catch(() => {});
  }

  return c.json({
    success: true,
    message: "Match process started in background",
  }, 202);
});

librariesRouter.post("/:id/scan", (c) => {
  return c.json({ result: "UPTODATE" });
});

// ── Series ────────────────────────────────────────────────────────────────────
librariesRouter.get("/:id/series", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const { data: seriesRows, error, count } = await supabase
    .from("series")
    .select(
      "*, book_series(book_id, sequence, library_items(id, title, cover_path, media_id))",
      {
        count: "exact",
      },
    )
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const results = (seriesRows || []).map((s: any) => {
    const books = (s.book_series || []).map((bs: any) => ({
      id: bs.book_id,
      sequence: bs.sequence,
      title: bs.library_items?.title || "",
      cover: bs.library_items?.cover_path || null,
    }));
    return {
      id: s.id,
      name: s.name,
      nameIgnorePrefix: s.name_ignore_prefix || s.name,
      description: s.description || null,
      libraryId: s.library_id,
      addedAt: new Date(s.created_at).getTime(),
      updatedAt: new Date(s.updated_at || s.created_at).getTime(),
      books,
      numBooks: books.length,
    };
  });

  return c.json({
    results,
    total: count || 0,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
  });
});

// ── Authors ───────────────────────────────────────────────────────────────────
librariesRouter.get("/:id/authors", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const { data: authorRows, error, count } = await supabase
    .from("authors")
    .select("*", { count: "exact" })
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const authors = (authorRows || []).map((a: any) => ({
    id: a.id,
    name: a.name,
    asin: a.asin || null,
    description: a.description || null,
    imagePath: a.image_path || null,
    libraryId: a.library_id,
    addedAt: new Date(a.created_at).getTime(),
    updatedAt: new Date(a.updated_at || a.created_at).getTime(),
    numBooks: 0,
  }));

  return c.json({
    authors,
    total: count || 0,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
  });
});

librariesRouter.get("/:id/personalized", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const libraryId = c.req.param("id");

  // --- Resolve all library_item_ids for this library up-front.
  // This is the idiomatic two-step pattern for PostgREST: filter on a direct
  // column of the driving table rather than using dot-notation join filters,
  // which are unreliable across PostgREST versions and silently drop rows when
  // the embedded filter can't be pushed into the join condition.
  const { data: libraryItemRows } = await supabase
    .from("library_items")
    .select("id")
    .eq("library_id", libraryId);

  const libraryItemIds = (libraryItemRows || []).map((r) => r.id);

  // --- Recently Added ---
  // Fetch in a separate query so it stays a simple ORDER BY created_at scan.
  const { data: recentItems } = await supabase
    .from("library_items")
    .select("*, books(*, book_authors(authors(*)), book_series(series(*)))")
    .eq("library_id", libraryId)
    .order("created_at", { ascending: false })
    .limit(10);

  // Attach progress to recently-added items
  const recentItemIds = (recentItems || []).map((i) => i.id);
  let recentProgressMap = new Map<string, any>();
  if (recentItemIds.length > 0) {
    const { data: recentProgressData } = await supabase
      .from("media_progress")
      .select("*")
      .eq("user_id", user.id)
      .in("library_item_id", recentItemIds)
      .is("episode_id", null);
    recentProgressMap = new Map(
      (recentProgressData || []).map((p: any) => [p.library_item_id, p]),
    );
  }

  const formattedRecent = (recentItems || []).map((item: any) =>
    mapBookForMobile(item, recentProgressMap.get(item.id) ?? null)
  );

  // --- Continue Listening & Listen Again ---
  // Drive from media_progress → library_items using a direct .in() filter on
  // library_item_id (a real uuid column with a proper FK after the schema fix).
  // This avoids the !inner dot-notation pattern that silently dropped rows.
  const [continueResult, listenAgainResult] = libraryItemIds.length > 0
    ? await Promise.all([
      supabase
        .from("media_progress")
        .select(
          "*, library_items(*, books(*, book_authors(authors(*)), book_series(series(*))))",
        )
        .eq("user_id", user.id)
        .in("library_item_id", libraryItemIds)
        .eq("is_finished", false)
        .eq("hide_from_continue_listening", false)
        .is("episode_id", null)
        .order("last_update", { ascending: false })
        .limit(30),
      supabase
        .from("media_progress")
        .select(
          "*, library_items(*, books(*, book_authors(authors(*)), book_series(series(*))))",
        )
        .eq("user_id", user.id)
        .in("library_item_id", libraryItemIds)
        .eq("is_finished", true)
        .is("episode_id", null)
        .order("last_update", { ascending: false })
        .limit(30),
    ])
    : [{ data: [] }, { data: [] }];

  const continueItems = ((continueResult.data || []) as any[])
    .filter((p) => p.library_items)
    .map((p) => mapBookForMobile(p.library_items, p))
    .filter(Boolean);

  const listenAgainItems = ((listenAgainResult.data || []) as any[])
    .filter((p) => p.library_items)
    .map((p) => mapBookForMobile(p.library_items, p))
    .filter(Boolean);

  const shelves: Array<{
    id: string;
    label: string;
    labelStringKey: string;
    type: string;
    entities: any[];
    total: number;
  }> = [];

  if (continueItems.length > 0) {
    shelves.push({
      id: "continue-listening",
      label: "Continue Listening",
      labelStringKey: "LabelContinueListening",
      type: "book",
      entities: continueItems,
      total: continueItems.length,
    });
  }

  if (listenAgainItems.length > 0) {
    shelves.push({
      id: "listen-again",
      label: "Listen Again",
      labelStringKey: "LabelListenAgain",
      type: "book",
      entities: listenAgainItems,
      total: listenAgainItems.length,
    });
  }

  shelves.push({
    id: "recently-added",
    label: "Recently Added",
    labelStringKey: "LabelRecentlyAdded",
    type: "book",
    entities: formattedRecent,
    total: formattedRecent.length,
  });

  return c.json(shelves);
});
