import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Context, Hono } from "npm:hono@^4.6.0";
import { z } from "npm:zod@^3.23.8";
import { zValidator } from "npm:@hono/zod-validator@^0.4.0";
import { ApiError } from "./_shared/errors.ts";
import { Variables } from "./_shared/types.ts";
import { handleChapterAI } from "./routes/items.ts";
import { generateBookAIInsights } from "../_shared/zai.ts";

export const aiRouter = new Hono<{ Variables: Variables }>();

const insightsRequestSchema = z.object({
  bookId: z.string().min(1),
  title: z.string().min(1),
  author: z.string().optional().nullable(),
});

export interface BookInsights {
  bookId: string;
  title: string;
  author: string | null;
  summary: string;
  keyTakeaways: string[];
  mood: string;
  themes: string[];
  isCached: boolean;
}

export async function ensureBookAIInsights(
  supabase: any,
  bookId: string,
  title: string,
  author: string | null | undefined,
): Promise<BookInsights> {
  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ?? Deno.env.get("ZHIPU_API_KEY") ?? "";

  // 1. Check DB cache
  const { data: existing, error: dbError } = await supabase
    .from("book_insights")
    .select("*")
    .eq("book_id", bookId)
    .maybeSingle();

  if (!dbError && existing) {
    return {
      bookId: existing.book_id,
      title: existing.book_title,
      author: existing.book_author,
      summary: existing.summary,
      keyTakeaways: existing.key_takeaways || [],
      mood: existing.mood || "Reflective",
      themes: existing.themes || [],
      isCached: true,
    };
  }

  // 2. Generate with LLM AI Engine
  const generated = await generateBookAIInsights(title, author, zaiApiKey);

  // 3. Persist to PostgreSQL book_insights table
  const { error: insertError } = await supabase.from("book_insights").upsert({
    book_id: bookId,
    book_title: title,
    book_author: author || null,
    summary: generated.summary,
    key_takeaways: generated.keyTakeaways,
    mood: generated.mood,
    themes: generated.themes,
    updated_at: new Date().toISOString(),
  });

  if (insertError) {
    console.warn("[aiService] Failed to persist book insights to DB:", insertError.message);
  }

  return {
    bookId,
    title,
    author: author || null,
    summary: generated.summary,
    keyTakeaways: generated.keyTakeaways,
    mood: generated.mood,
    themes: generated.themes,
    isCached: false,
  };
}

aiRouter.post(
  "/insights",
  zValidator("json", insightsRequestSchema),
  async (c) => {
    const { bookId, title, author } = c.req.valid("json");
    const supabase = c.get("supabase");

    try {
      const insights = await ensureBookAIInsights(supabase, bookId, title, author);
      return c.json<BookInsights>(insights);
    } catch (err: any) {
      console.error("[aiRouter] Error generating insights:", err);
      throw new ApiError(err.message || "Failed to generate insights", "AI_INSIGHTS_ERROR", 500);
    }
  }
);

aiRouter.post("/chapter", handleChapterAI);
aiRouter.post("/chapter-ai", handleChapterAI);
