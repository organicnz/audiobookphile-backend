import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { ZAI_CHAT_MODEL } from "../../_shared/zai.ts";

/**
 * Embedding model for semantic search. z.ai retired embedding-2/embedding-3
 * (API error 1211); until a valid model name is configured via
 * ZAI_EMBEDDING_MODEL, this endpoint returns its documented 5xx error shape.
 */
const ZAI_EMBEDDING_MODEL = Deno.env.get("ZAI_EMBEDDING_MODEL") ??
  "embedding-3";
import { LibraryItemWithBooks, mapBookForMobile } from "../../api/mappers.ts";
import { Context } from "hono";
import { Variables } from "../_shared/types.ts";

export const searchRouter = createOpenApiRouter();

// ===== Zod schemas for search endpoints =====
const SmartSearchBodySchema = z.object({
  query: z.string().max(256),
  libraryId: z.string().optional(),
});

const GenerateEmbeddingBodySchema = z.object({
  text: z.string().max(4096).optional(), // 16KB max for embeddings
  input: z.string().max(4096).optional(),
});

const ServerErrorSchema = z.object({ error: z.string() });
const HistoryResultSchema = z.array(z.record(z.string(), z.any()));
const HistoryCreateSchema = z.object({ query: z.string().max(256) });
const SuccessSchema = z.object({ success: z.boolean() });
const SmartSearchResultSchema = z.object({
  results: z.array(z.record(z.string(), z.any())),
  searchIntent: z.record(z.string(), z.any()),
});
const EmbeddingResultSchema = z.object({
  embedding: z.array(z.number()),
  model: z.string(),
});

const getHistoryRoute = {
  method: "get" as const,
  path: "/history",
  tags: ["search"],
  responses: {
    200: {
      description: "Get search history",
      content: { "application/json": { schema: HistoryResultSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const createHistoryRoute = {
  method: "post" as const,
  path: "/history",
  tags: ["search"],
  request: {
    body: {
      content: { "application/json": { schema: HistoryCreateSchema } },
    },
  },
  responses: {
    201: {
      description: "History created",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
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

const deleteHistoryRoute = {
  method: "delete" as const,
  path: "/history",
  tags: ["search"],
  responses: {
    200: {
      description: "History deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const createSmartSearchRoute = (path: string) => ({
  method: "post" as const,
  path,
  tags: ["search"],
  request: {
    body: {
      content: { "application/json": { schema: SmartSearchBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: SmartSearchResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
});

const createEmbeddingRoute = (path: string) => ({
  method: "post" as const,
  path,
  tags: ["search"],
  request: {
    body: {
      content: { "application/json": { schema: GenerateEmbeddingBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Embedding generated",
      content: { "application/json": { schema: EmbeddingResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
});

searchRouter.openapi(getHistoryRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  const { data: history, error } = await supabase.from("search_history").select(
    "*",
  ).eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(history, 200);
});

searchRouter.openapi(createHistoryRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = HistoryCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const query = parsed.data.query;

  // Delete any existing exact same query to avoid duplicates and move it to top
  await supabase.from("search_history").delete().eq("user_id", user.id).eq(
    "query",
    query,
  );

  const { data: newHistory, error } = await supabase
    .from("search_history")
    .insert({
      user_id: user.id,
      query: query,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json(newHistory, 201);
});

searchRouter.openapi(deleteHistoryRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;

  const { error } = await supabase.from("search_history").delete().eq(
    "user_id",
    user.id,
  );

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true }, 200);
});

/**
 * Handles smart search requests using AI embeddings and database matching.
 * Validates the query and generates/searches embeddings to return matched library items.
 *
 * @param c - The Hono Context object containing environment variables and the Supabase client.
 * @returns A JSON response with the search results or an error object.
 */
async function handleSmartSearch(c: Context<{ Variables: Variables }>) {
  const supabase = c.get("supabase");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = SmartSearchBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const queryText = parsed.data.query || "";
  const libraryId = parsed.data.libraryId || "";

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
            Authorization: `Bearer ${zaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: ZAI_CHAT_MODEL,
            thinking: { type: "disabled" },
            messages: [
              {
                role: "user",
                content:
                  `Extract key search terms, author name, and genre from this natural search query: "${queryText}". Return ONLY a JSON object: {"terms": ["..."], "author": "...", "genre": "..."}`,
              },
            ],
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

  return c.json({ results: formattedResults, searchIntent }, 200);
}

searchRouter.openapi(createSmartSearchRoute("/smart"), handleSmartSearch);
searchRouter.openapi(createSmartSearchRoute("/semantic"), handleSmartSearch);
searchRouter.openapi(
  createSmartSearchRoute("/search-semantic"),
  handleSmartSearch,
);

/**
 * Handles requests to generate an embedding for a given text using the Zhipu AI / ZAI model.
 * Note: Only for debugging or internal admin usage.
 *
 * @param c - The Hono Context object containing environment variables.
 * @returns A JSON response with the generated embedding or an error object.
 */
async function handleGenerateEmbedding(c: Context<{ Variables: Variables }>) {
  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = GenerateEmbeddingBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const text = parsed.data.text || parsed.data.input || "";
  if (!text) {
    return c.json({ error: "Text or input is required" }, 400);
  }
  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";
  if (!zaiApiKey) {
    return c.json({ error: "ZAI_API_KEY is not configured" }, 500);
  }
  try {
    const aiRes = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ZAI_EMBEDDING_MODEL,
          input: text,
        }),
      },
    );
    if (!aiRes.ok) {
      return c.json({ error: "Failed to generate embedding" }, 500);
    }
    const aiData = await aiRes.json();
    return c.json({
      embedding: aiData.data?.[0]?.embedding || [],
      model: ZAI_EMBEDDING_MODEL,
    }, 200);
  } catch (e: unknown) {
    return c.json({
      error: (e as Error).message || "Embedding generation failed",
    }, 500);
  }
}

searchRouter.openapi(
  createEmbeddingRoute("/generate-embedding"),
  handleGenerateEmbedding,
);
searchRouter.openapi(
  createEmbeddingRoute("/embeddings/generate"),
  handleGenerateEmbedding,
);
