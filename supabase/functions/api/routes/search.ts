import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

export const searchRouter = new Hono<{ Variables: Variables }>();

searchRouter.get("/history", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  const { data: history, error } = await supabase
    .from("search_history")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(history);
});

searchRouter.post("/history", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!body.query || typeof body.query !== "string") {
    return c.json({ error: "query is required" }, 400);
  }

  // Delete any existing exact same query to avoid duplicates and move it to top
  await supabase
    .from("search_history")
    .delete()
    .eq("user_id", user.id)
    .eq("query", body.query);

  const { data: newHistory, error } = await supabase
    .from("search_history")
    .insert({
      user_id: user.id,
      query: body.query,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(newHistory, 201);
});

searchRouter.delete("/history", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  const { error } = await supabase
    .from("search_history")
    .delete()
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true });
});
