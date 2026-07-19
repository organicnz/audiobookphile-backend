import { Hono } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
// getProxyOrigin removed
import { Variables } from "../_shared/types.ts";
import { fetchAuthorAvatar } from "../../_shared/avatarFetcher.ts";

export const authorsRouter = new Hono<{ Variables: Variables }>();

authorsRouter.patch("/:id", async (c) => {
  const supabase = c.get("supabase");
  const authorId = c.req.param("id");
  const body = await c.req.json();

  const { data, error } = await supabase.from("authors").update({
    name: body.name,
    description: body.description,
    image_path: body.imagePath,
  }).eq("id", authorId).select().single();

  if (error) throw error;
  return c.json({ updated: true, author: data });
});

authorsRouter.delete("/:id", async (c) => {
  const supabase = c.get("supabase");
  const authorId = c.req.param("id");

  const { error } = await supabase.from("authors").delete().eq("id", authorId);
  if (error) throw error;
  return c.json({ success: true });
});

authorsRouter.post("/:id/match", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const authorId = c.req.param("id");
  const payload = await c.req.json();
  const authorName = payload.q || payload.author || "";

  if (!authorName) return c.json({ error: "Author name required" }, 400);

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
      } catch { /* ignore */ }
    }

    const db = createClient(supabaseUrl, serviceRoleKey);
    const storagePath = await fetchAuthorAvatar(db, { id: authorId, name: authorName });
    if (storagePath) {
      updates.image_path = storagePath;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No updates found" }, 404);
    }

    const { data: updated, error } = await supabase.from("authors").update(
      updates,
    ).eq("id", authorId).select().single();
    if (error) throw error;
    return c.json({ updated: true, author: updated });
  } catch (e: unknown) {
    const err = e as Error;
    return c.json({ error: err.message }, 500);
  }
});



authorsRouter.post("/:id/image", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const authorId = c.req.param("id");

  const { url: imgUrl } = await c.req.json();
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
  return c.json({ imagePath: storagePath });
});

authorsRouter.delete("/:id/image", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const authorId = c.req.param("id");

  await supabase.from("authors").update({ image_path: null }).eq(
    "id",
    authorId,
  );
  return c.json({ success: true });
});
