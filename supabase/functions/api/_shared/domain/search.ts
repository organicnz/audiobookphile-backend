/**
 * Search domain module - business logic for search operations.
 *
 * Provides:
 * - Smart search with intent detection
 * - Embedding generation
 * - Search history management
 * - Query optimization
 */

import { z } from "zod";
import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { CommonSchemas, MAX_LENGTHS } from "../validation.ts";

// =============================================================================
// Domain Types
// =============================================================================

/**
 * Search intent types.
 */
export const SearchIntentEnum = z.enum([
  "title_search",
  "author_search",
  "genre_search",
  "general_search",
  "recommendation_request",
]);
export type SearchIntent = z.infer<typeof SearchIntentEnum>;

/**
 * Smart search request schema.
 */
export const SmartSearchSchema = z.object({
  query: CommonSchemas.searchQuery,
  libraryId: z.string().optional(),
  userId: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export type SmartSearchParams = z.infer<typeof SmartSearchSchema>;

/**
 * Search result item.
 */
export interface SearchResultItem {
  id: string;
  title: string;
  author: string;
  score: number;
  highlights?: Record<string, string[]>;
}

/**
 * Smart search response.
 */
export interface SmartSearchResult {
  results: SearchResultItem[];
  intent: SearchIntent;
  query: string;
  processingTime: number;
}

/**
 * Search history item.
 */
export interface SearchHistoryItem {
  id: string;
  query: string;
  timestamp: string;
  resultCount: number;
}

// =============================================================================
// Intent Detection
// =============================================================================

/**
 * Keywords for intent detection.
 */
const INTENT_KEYWORDS: Record<SearchIntent, string[]> = {
  title_search: ["book", "title", "named", "called"],
  author_search: ["by", "author", "written by", "narrated by"],
  genre_search: ["genre", "category", "type", "kind of"],
  general_search: [],
  recommendation_request: ["recommend", "suggest", "similar to", "like"],
};

/**
 * Detect search intent from query text.
 */
export function detectSearchIntent(query: string): SearchIntent {
  const lowerQuery = query.toLowerCase();

  // Check for recommendation patterns
  for (const keyword of INTENT_KEYWORDS.recommendation_request) {
    if (lowerQuery.includes(keyword)) {
      return "recommendation_request";
    }
  }

  // Check for author patterns
  for (const keyword of INTENT_KEYWORDS.author_search) {
    if (lowerQuery.includes(keyword)) {
      return "author_search";
    }
  }

  // Check for genre patterns
  for (const keyword of INTENT_KEYWORDS.genre_search) {
    if (lowerQuery.includes(keyword)) {
      return "genre_search";
    }
  }

  // Default to general search
  return "general_search";
}

/**
 * Extract search terms based on intent.
 */
export function extractSearchTerms(
  query: string,
  intent: SearchIntent,
): { primary: string; secondary?: string } {
  const words = query.trim().split(/\s+/);

  switch (intent) {
    case "author_search": {
      const byIndex = words.findIndex((w) =>
        ["by", "author", "written"].includes(w.toLowerCase())
      );
      if (byIndex >= 0 && byIndex < words.length - 1) {
        return {
          primary: words.slice(byIndex + 1).join(" "),
          secondary: words.slice(0, byIndex).join(" "),
        };
      }
      return { primary: query };
    }

    case "genre_search": {
      const genreIndex = words.findIndex((w) =>
        ["genre", "category", "type"].includes(w.toLowerCase())
      );
      if (genreIndex >= 0 && genreIndex < words.length - 1) {
        return { primary: words.slice(genreIndex + 1).join(" ") };
      }
      return { primary: query };
    }

    default:
      return { primary: query };
  }
}

// =============================================================================
// Search Operations
// =============================================================================

/**
 * Execute a full-text search.
 */
export async function executeFullTextSearch(
  supabase: SupabaseClient,
  params: SmartSearchParams,
): Promise<SearchResultItem[]> {
  let query = supabase
    .from("library_items")
    .select("id, title, author, media_id", { count: "exact" })
    .textSearch("title_author_search", params.query, {
      type: "websearch",
      config: "english",
    })
    .limit(params.limit);

  if (params.libraryId) {
    query = query.eq("library_id", params.libraryId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Search failed: ${error.message}`);
  }

  return (data || []).map((item, index) => ({
    id: item.id,
    title: item.title,
    author: item.author || "Unknown",
    score: 1.0 - index * 0.1, // Simple relevance scoring
  }));
}

/**
 * Save search to history.
 */
export async function saveSearchHistory(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  resultCount: number,
): Promise<void> {
  const { error } = await supabase.from("search_history").insert({
    user_id: userId,
    query: query.slice(0, MAX_LENGTHS.SEARCH_QUERY),
    result_count: resultCount,
  });

  if (error) {
    console.error("Failed to save search history:", error.message);
    // Don't throw - search history is non-critical
  }
}

/**
 * Get recent search history for a user.
 */
export async function getSearchHistory(
  supabase: SupabaseClient,
  userId: string,
  limit = 10,
): Promise<SearchHistoryItem[]> {
  const { data, error } = await supabase
    .from("search_history")
    .select("id, query, created_at, result_count")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to get search history: ${error.message}`);
  }

  return (data || []).map((item) => ({
    id: item.id,
    query: item.query,
    timestamp: item.created_at,
    resultCount: item.result_count || 0,
  }));
}

/**
 * Clear search history for a user.
 */
export async function clearSearchHistory(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from("search_history")
    .delete()
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to clear search history: ${error.message}`);
  }
}

// =============================================================================
// Embedding Operations
// =============================================================================

/**
 * Generate embedding for text (placeholder for AI integration).
 */
export async function generateEmbedding(
  _text: string,
): Promise<{ embedding: number[]; model: string }> {
  // TODO: Integrate with actual embedding service (e.g., OpenAI, ZAI)
  // This is a placeholder that returns a dummy embedding
  console.warn("Embedding generation not yet implemented");

  return {
    embedding: [],
    model: "placeholder",
  };
}
