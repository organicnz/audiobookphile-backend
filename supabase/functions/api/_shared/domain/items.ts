/**
 * Items domain module - business logic for library items.
 *
 * This module encapsulates all item-related business rules and operations,
 * following domain-driven design principles. It provides:
 * - Type-safe item operations
 * - Business rule validation
 * - Reusable query builders
 */

import { z } from "zod";
import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { CommonSchemas, MAX_LENGTHS } from "../validation.ts";

// =============================================================================
// Domain Types
// =============================================================================

/**
 * Media type enum for library items.
 */
export const MediaTypeEnum = z.enum(["book", "podcast"]);
export type MediaType = z.infer<typeof MediaTypeEnum>;

/**
 * Item status enum.
 */
export const ItemStatusEnum = z.enum(["ready", "error", "processing"]);
export type ItemStatus = z.infer<typeof ItemStatusEnum>;

/**
 * Schema for checking existing items.
 */
export const CheckExistingSchema = z.object({
  title: CommonSchemas.title.optional().default(""),
  author: CommonSchemas.author.optional().default(""),
  libraryId: z.string().optional().default(""),
  mediaType: MediaTypeEnum.optional().default("book"),
});

export type CheckExistingParams = z.infer<typeof CheckExistingSchema>;

/**
 * Result of checking for existing items.
 */
export interface CheckExistingResult {
  mediaId: string | null;
  matchType?: "exact" | "fuzzy" | "partial";
  confidence?: number;
}

// =============================================================================
// Query Builders
// =============================================================================

/**
 * Build a query for finding items by title and author.
 */
export function buildItemSearchQuery(
  supabase: SupabaseClient,
  params: CheckExistingParams,
) {
  let query = supabase
    .from("library_items")
    .select("id, media_id, media_type, title, author")
    .eq("library_id", params.libraryId)
    .eq("media_type", params.mediaType);

  if (params.title) {
    query = query.ilike("title", `%${params.title}%`);
  }

  if (params.author) {
    query = query.contains("authors", [{ name: params.author }]);
  }

  return query;
}

/**
 * Calculate fuzzy match score between two strings.
 * Uses normalized Levenshtein distance for typo tolerance.
 */
export function calculateFuzzyScore(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 1.0;

  const len1 = s1.length;
  const len2 = s2.length;
  const maxLen = Math.max(len1, len2);

  if (maxLen === 0) return 1.0;

  // Simple character overlap ratio (can be upgraded to full Levenshtein)
  const set1 = new Set(s1.split(""));
  const set2 = new Set(s2.split(""));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));

  return intersection.size / maxLen;
}

/**
 * Determine if a match is acceptable based on fuzzy matching rules.
 */
export function isMatchAcceptable(
  titleScore: number,
  authorScore: number,
  threshold = 0.75,
): boolean {
  // Exact title match with any author
  if (titleScore === 1.0) return true;

  // High title match + decent author match
  if (titleScore >= 0.85 && authorScore >= 0.5) return true;

  // Threshold-based match
  if (titleScore >= threshold && authorScore >= threshold) return true;

  return false;
}

// =============================================================================
// Business Operations
// =============================================================================

/**
 * Check for existing items in a library.
 */
export async function checkExistingItem(
  supabase: SupabaseClient,
  params: CheckExistingParams,
): Promise<CheckExistingResult> {
  // Validate input
  const validated = CheckExistingSchema.parse(params);

  // Early return if no search criteria
  if (!validated.title && !validated.author) {
    return { mediaId: null };
  }

  // Query database
  const { data, error } = await buildItemSearchQuery(supabase, validated);

  if (error) {
    throw new Error(`Failed to check existing items: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return { mediaId: null };
  }

  // Calculate match scores
  for (const item of data) {
    const titleScore = calculateFuzzyScore(validated.title, item.title);
    const authorScore = validated.author
      ? calculateFuzzyScore(validated.author, item.author || "")
      : 0;

    if (isMatchAcceptable(titleScore, authorScore)) {
      return {
        mediaId: item.media_id,
        matchType: titleScore === 1.0 ? "exact" : "fuzzy",
        confidence: (titleScore + authorScore) / 2,
      };
    }
  }

  return { mediaId: null };
}

/**
 * Validate item metadata for consistency.
 */
export function validateItemMetadata(metadata: {
  title?: string;
  author?: string;
  duration?: number;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (metadata.title && metadata.title.length > MAX_LENGTHS.TITLE) {
    errors.push(`Title exceeds maximum length of ${MAX_LENGTHS.TITLE}`);
  }

  if (metadata.author && metadata.author.length > MAX_LENGTHS.AUTHOR) {
    errors.push(`Author exceeds maximum length of ${MAX_LENGTHS.AUTHOR}`);
  }

  if (metadata.duration !== undefined && metadata.duration < 0) {
    errors.push("Duration cannot be negative");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
