import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const collectionsRouter = createOpenApiRouter();

// ===== Zod schemas for collection endpoints =====
const CollectionCreateSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  items: z.array(z.string()).optional(), // array of item IDs to add (auto-ordered)
});

const CollectionUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});

const CollectionItemsPayloadSchema = z.array(z.string()); // array of library item IDs

const ServerErrorSchema = z.object({ error: z.string() });
const CollectionResultSchema = z.record(z.string(), z.any());
const SuccessSchema = z.object({ success: z.boolean() });

const createCollectionRoute = {
  method: "post" as const,
  path: "/",
  tags: ["collections"],
  request: {
    body: {
      content: { "application/json": { schema: CollectionCreateSchema } },
    },
  },
  responses: {
    200: {
      description: "Collection created",
      content: { "application/json": { schema: CollectionResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updateCollectionRoute = {
  method: "patch" as const,
  path: "/:id",
  tags: ["collections"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: CollectionUpdateSchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Collection updated",
      content: { "application/json": { schema: CollectionResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deleteCollectionRoute = {
  method: "delete" as const,
  path: "/:id",
  tags: ["collections"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Collection deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const addCollectionItemsRoute = {
  method: "post" as const,
  path: "/:id/items",
  tags: ["collections"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: CollectionItemsPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Items added to collection",
      content: { "application/json": { schema: CollectionResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deleteCollectionItemRoute = {
  method: "delete" as const,
  path: "/:id/items/:itemId",
  tags: ["collections"],
  request: {
    params: z.object({ id: z.string(), itemId: z.string() }),
  },
  responses: {
    200: {
      description: "Item removed from collection",
      content: { "application/json": { schema: CollectionResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

collectionsRouter.openapi(createCollectionRoute, async (c) => {
  const supabase = c.get("supabase");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = CollectionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { libraryId, name, description, items } = parsed.data;
  const newId = crypto.randomUUID();

  // Validate item IDs (if provided)
  if (items && items.length > 0) {
    for (const itemId of items) {
      try {
        z.string().uuid().parse(itemId);
      } catch (_e) {
        return c.json({ error: `Invalid library item ID: ${itemId}` }, 400);
      }
    }
  }

  const { data, error } = await supabase
    .from("collections")
    .insert({
      id: newId,
      library_id: libraryId,
      name,
      description: description ?? null,
    })
    .select()
    .single();
  if (error) {
    console.error("[collections] Create error:", error);
    return c.json({ error: "Failed to create collection" }, 500);
  }

  if (items && items.length > 0) {
    const collectionItems = items.map((item: string, index: number) => ({
      id: crypto.randomUUID(),
      collection_id: data.id,
      library_item_id: item,
      order: index,
    }));
    await supabase.from("collection_items").insert(collectionItems);
  }
  return c.json(data, 200);
});

collectionsRouter.openapi(updateCollectionRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: collectionId } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema (partial update allowed - optional fields)
  const parsed = CollectionUpdateSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { name, description } = parsed.data;

  const { data, error } = await supabase
    .from("collections")
    .update({
      name,
      description,
    })
    .eq("id", collectionId)
    .select()
    .single();
  if (error) {
    console.error("[collections] Update error:", error);
    return c.json({ error: "Failed to update collection" }, 500);
  }
  return c.json(data, 200);
});

collectionsRouter.openapi(deleteCollectionRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: collectionId } = c.req.valid("param");

  const { error } = await supabase.from("collections").delete().eq(
    "id",
    collectionId,
  );
  if (error) {
    console.error("[collections] Delete error:", error);
    return c.json({ error: "Failed to delete collection" }, 500);
  }
  return c.json({ success: true }, 200);
});

collectionsRouter.openapi(addCollectionItemsRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: collectionId } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = CollectionItemsPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "items array is required" }, 400);
  }

  // Validate each item ID as UUID
  for (const itemId of parsed.data) {
    try {
      z.string().uuid().parse(itemId);
    } catch (_e) {
      return c.json({ error: `Invalid library item ID: ${itemId}` }, 400);
    }
  }

  const { count } = await supabase
    .from("collection_items")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("collection_id", collectionId);
  const newId = crypto.randomUUID();
  await supabase.from("collection_items").insert({
    id: newId,
    collection_id: collectionId,
    library_item_id: parsed.data[0],
    order: count ?? 0,
  });

  const { data, error } = await supabase.from("collections").select(
    "*, collection_items(*)",
  ).eq("id", collectionId).single();
  if (error) {
    console.error("[collections] Add item error:", error);
    return c.json({ error: "Failed to add item to collection" }, 500);
  }
  return c.json(data, 200);
});

collectionsRouter.openapi(deleteCollectionItemRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: collectionId, itemId: libraryItemId } = c.req.valid("param");

  // Validate itemId as UUID before deleting
  try {
    z.string().uuid().parse(libraryItemId);
  } catch (_e) {
    return c.json({ error: `Invalid library item ID: ${libraryItemId}` }, 400);
  }

  await supabase.from("collection_items").delete().eq(
    "collection_id",
    collectionId,
  ).eq("library_item_id", libraryItemId);

  const { data, error } = await supabase.from("collections").select(
    "*, collection_items(*)",
  ).eq("id", collectionId).single();
  if (error) {
    console.error("[collections] Delete item error:", error);
    return c.json({ error: "Failed to delete item from collection" }, 500);
  }
  return c.json(data, 200);
});
