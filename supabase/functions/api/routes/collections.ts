import { z } from "zod";
import { Hono } from "hono";

import { Variables } from "../_shared/types.ts";
export const collectionsRouter = new Hono<{ Variables: Variables }>();

// ===== Zod schemas for collection endpoints =====
const CollectionCreateSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  items: z.array(z.number()).optional(), // array of item IDs to add (auto-ordered)
});

const CollectionUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});

const CollectionItemsPayloadSchema = z.array(z.number()); // array of library item IDs

collectionsRouter.post("/", async (c) => {
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
        z.string().uuid().safeParse(itemId.toString());
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
  if (error) throw error;

  if (items && items.length > 0) {
    const collectionItems = items.map((item: any, index: number) => ({
      id: crypto.randomUUID(),
      collection_id: data.id,
      library_item_id: item,
      order: index,
    }));
    await supabase.from("collection_items").insert(collectionItems);
  }
  return c.json(data);
});

collectionsRouter.patch("/:id", async (c) => {
  const supabase = c.get("supabase");
  const collectionId = c.req.param("id");

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
  if (error) throw error;
  return c.json(data);
});

collectionsRouter.delete("/:id", async (c) => {
  const supabase = c.get("supabase");
  const collectionId = c.req.param("id");

  const { error } = await supabase.from("collections").delete().eq(
    "id",
    collectionId,
  );
  if (error) throw error;
  return c.json({ success: true });
});

collectionsRouter.post("/:id/items", async (c) => {
  const supabase = c.get("supabase");
  const collectionId = c.req.param("id");

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
      z.string().uuid().safeParse(itemId.toString());
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
    library_item_id: parsed.data[0].toString(),
    order: count ?? 0,
  });

  const { data, error } = await supabase.from("collections").select(
    "*, collection_items(*)",
  ).eq("id", collectionId).single();
  if (error) throw error;
  return c.json(data);
});

collectionsRouter.delete("/:id/items/:itemId", async (c) => {
  const supabase = c.get("supabase");
  const collectionId = c.req.param("id");
  const libraryItemId = c.req.param("itemId");

  // Validate itemId as UUID before deleting
  try {
    z.string().uuid().safeParse(libraryItemId);
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
  if (error) throw error;
  return c.json(data);
});
