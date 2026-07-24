import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";
import { LibraryItemWithBooks, mapBookForMobile } from "../mappers.ts";

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

searchRouter.post("/smart", async (c) => {
  const supabase = c.get("supabase");
  const body = await c.req.json().catch(() => ({}));
  const queryText = body.query || "";
  const libraryId = body.libraryId || "";

  if (!queryText) {
    return c.json({ error: "Query is required" }, 400);
  }

  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";
  let searchIntent = { terms: [queryText], author: "", genre: "" };

  if (zaiApiKey) {
    try {
      const aiRes = await fetch(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${zaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "glm-4-flash",
            messages: [{
              role: "user",
              content:
                `Extract key search terms, author name, and genre from this natural search query: "${queryText}". Return ONLY a JSON object: {"terms": ["..."], "author": "...", "genre": "..."}`,
            }],
            temperature: 0.1,
          }),
        },
      );
      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const text = aiData.choices?.[0]?.message?.content || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          searchIntent = JSON.parse(match[0]);
        }
      }
    } catch (_e) {
      // Fallback
    }
  }

  let dbQuery = supabase.from("library_items").select(
    "*, book_authors(authors(*)), book_series(series(*))",
  );
  if (libraryId) dbQuery = dbQuery.eq("library_id", libraryId);

  const term = (searchIntent.terms?.[0] || queryText).trim();
  dbQuery = dbQuery.or(
    `title.ilike.%${term}%,author_names_first_last.ilike.%${term}%,description.ilike.%${term}%,subtitle.ilike.%${term}%,publisher.ilike.%${term}%`,
  );

  const { data: results, error } = await dbQuery.limit(50);
  if (error) return c.json({ error: error.message }, 500);

  const formattedResults = (results || []).map((item) =>
    mapBookForMobile(item as unknown as LibraryItemWithBooks)
  );

  return c.json({ results: formattedResults, searchIntent });
});
