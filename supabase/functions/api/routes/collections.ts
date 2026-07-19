import { Hono } from "hono";

import { Variables } from "../_shared/types.ts";
export const collectionsRouter = new Hono<{ Variables: Variables }>();

collectionsRouter.post("/", async (c) => {
  const supabase = c.get("supabase");
  const { libraryId, name, description, items } = await c.req.json();
  const newId = crypto.randomUUID();

  const { data, error } = await supabase.from("collections").insert({
    id: newId,
    library_id: libraryId,
    name,
    description: description ?? null,
  }).select().single();
  if (error) throw error;

  if (items && items.length > 0) {
    const collectionItems = items.map((item: any, index: number) => ({
      collection_id: data.id,
      library_item_id: item.libraryItemId,
      order: index,
    }));
    await supabase.from("collection_items").insert(collectionItems);
  }
  return c.json(data);
});

collectionsRouter.patch("/:id", async (c) => {
  const supabase = c.get("supabase");
  const collectionId = c.req.param("id");
  const { name, description } = await c.req.json();

  const { data, error } = await supabase.from("collections").update({
    name,
    description,
  }).eq("id", collectionId).select().single();
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
  const { libraryItemId } = await c.req.json();

  const { count } = await supabase.from("collection_items").select("*", {
    count: "exact",
    head: true,
  }).eq("collection_id", collectionId);
  const newId = crypto.randomUUID();
  await supabase.from("collection_items").insert({
    id: newId,
    collection_id: collectionId,
    library_item_id: libraryItemId,
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
