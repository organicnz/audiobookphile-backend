// ── Collections ───────────────────────────────────────────────────────────────
librariesRouter.get("/:id/collections", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const { data: collectionRows, error, count } = await supabase
    .from("collections")
    .select(
      "*, collection_books(book_id, order, books(id, title, cover_path, duration, library_items(id, cover_path, updated_at, created_at)))",
      { count: "exact" },
    )
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const results = (collectionRows || []).map((cObj: any) => {
    const books = (cObj.collection_books || []).map((cb: any) => {
      const book = cb.books;
      const libraryItem = Array.isArray(book?.library_items)
        ? book.library_items[0]
        : book?.library_items;
      const itemId = libraryItem?.id || cb.book_id;
      const coverPath = libraryItem?.cover_path || book?.cover_path || null;
      return {
        id: itemId,
        order: cb.order,
        title: book?.title || "",
        cover: coverPath,
        media: {
          id: book?.id,
          coverPath,
          duration: Number(book?.duration) || undefined,
        },
      };
    });
    // Sort books by order
    books.sort((a: any, b: any) => a.order - b.order);

    return {
      id: cObj.id,
      name: cObj.name,
      description: cObj.description || null,
      libraryId: cObj.library_id,
      addedAt: new Date(cObj.created_at).getTime(),
      updatedAt: new Date(cObj.updated_at || cObj.created_at).getTime(),
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

// ── Playlists ─────────────────────────────────────────────────────────────────
librariesRouter.get("/:id/playlists", async (c) => {
  const supabase = c.get("supabase");
  const libraryId = c.req.param("id");
  const qp = new URL(c.req.raw.url).searchParams;
  const limit = parseInt(qp.get("limit") || "24", 10);
  const page = parseInt(qp.get("page") || "0", 10);
  const sort = qp.get("sort") || "name";
  const desc = qp.get("desc") === "1";
  const offset = page * limit;
  const dbSortField = sort === "name" ? "name" : "created_at";

  const { data: playlistRows, error, count } = await supabase
    .from("playlists")
    .select(
      "*, playlist_media_items(media_item_id, order, books(id, title, cover_path, duration, library_items(id, cover_path, updated_at, created_at)))",
      { count: "exact" },
    )
    .eq("library_id", libraryId)
    .order(dbSortField, { ascending: !desc })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const results = (playlistRows || []).map((pObj: any) => {
    const items = (pObj.playlist_media_items || []).map((pm: any) => {
      const book = pm.books;
      const libraryItem = Array.isArray(book?.library_items)
        ? book.library_items[0]
        : book?.library_items;
      const itemId = libraryItem?.id || pm.media_item_id;
      const coverPath = libraryItem?.cover_path || book?.cover_path || null;
      return {
        id: itemId,
        order: pm.order,
        title: book?.title || "",
        cover: coverPath,
        media: {
          id: book?.id,
          coverPath,
          duration: Number(book?.duration) || undefined,
        },
      };
    });
    // Sort items by order
    items.sort((a: any, b: any) => a.order - b.order);

    return {
      id: pObj.id,
      name: pObj.name,
      description: pObj.description || null,
      libraryId: pObj.library_id,
      userId: pObj.user_id,
      addedAt: new Date(pObj.created_at).getTime(),
      updatedAt: new Date(pObj.updated_at || pObj.created_at).getTime(),
      items,
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
