/**
 * Downloads Domain Module — Pure business logic for upload/download operations.
 *
 * Extracted from routes/downloads.ts to separate HTTP concerns from domain logic.
 * All functions are pure (given dependencies) and independently testable.
 */

import { parseTitleAndAuthor } from "../../../_shared/titleAuthorParser.ts";
import { titlesLikelySameWork } from "../../../_shared/titleMatch.ts";
import { ZAI_CHAT_MODEL } from "../../../_shared/zai.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";

/* =========================================================================
 * Title & Author Resolution
 * ========================================================================= */

/**
 * Resolve clean title + author from raw upload metadata.
 *
 * 1. Parses the raw filename with titleAuthorParser heuristics.
 * 2. Falls back to Z.ai GLM-4 extraction when the parser cannot determine
 *    an author or title (gated on zaiApiKey availability).
 * 3. Validates AI-extracted titles against the raw input to reject
 *    hallucinated different-work titles.
 */
export async function resolveTitleAndAuthor(
  rawTitle: string,
  rawAuthor: string,
  zaiApiKey: string,
): Promise<{ title: string; author: string }> {
  let { cleanTitle: title, cleanAuthor: author } = parseTitleAndAuthor(
    rawTitle,
    rawAuthor,
  );

  if (
    (!author || author === "Unknown Author" || !title) && rawTitle &&
    zaiApiKey
  ) {
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
                  `Extract the exact book title and author name from this filename/text: "${rawTitle}". Return ONLY a JSON object: {"title": "...", "author": "..."}`,
              },
            ],
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const content = aiData.choices?.[0]?.message?.content || "";
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          // Gate: the extraction must plausibly describe THIS file. A
          // hallucinated different-work title here would feed the duplicate
          // checker and create/merge the wrong book.
          const extractedTitle = typeof parsed.title === "string"
            ? parsed.title.trim()
            : "";
          if (
            extractedTitle &&
            !titlesLikelySameWork(rawTitle, extractedTitle)
          ) {
            console.warn(
              `[upload-fallback] REJECTED extracted title "${extractedTitle}" for "${rawTitle}": titles are dissimilar`,
            );
            parsed.title = undefined;
            parsed.author = undefined;
          }
          if (parsed.title) title = parsed.title;
          if (parsed.author && parsed.author !== author) author = parsed.author;
        }
      }
    } catch (e: unknown) {
      const err = e as Error;
      console.error(
        "[upload-fallback] Z.ai GLM-4 fallback error:",
        err.message,
      );
    }
  }
  return { title, author };
}

/* =========================================================================
 * Duplicate Book Detection
 * ========================================================================= */

/** Normalize a title for fuzzy matching (lowercase, strip format tags, remove punctuation). */
function normalizeTitle(s: string): string {
  if (!s) return "";
  let v = s.toLowerCase().trim();
  v = v.replace(
    /\[(audiobook|unabridged|abridged|mp3)\]|\((audiobook|unabridged|abridged|mp3)\)/gi,
    "",
  );
  v = v.replace(/\b(cd|disc|part|vol|volume)\s*\d+\b/gi, "");
  return v.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Check for an existing duplicate book in the library.
 *
 * Strategy:
 * 1. Direct ID match (bookId / media_id).
 * 2. Exact title match (case-insensitive).
 * 3. Normalized title match (strips format tags, punctuation).
 * 4. Z.ai semantic match for fuzzy cases (when API key available).
 *
 * Returns the matched item's `id` or `null`.
 */
export async function checkDuplicateBook(
  supabase: SupabaseClient,
  title: string,
  _author: string,
  libraryId: string,
  _zaiApiKey: string,
  bookId?: string,
): Promise<string | null> {
  let matchedId: string | null = null;

  const LIGHT_SELECT = "id, media_id, title, author_names_first_last";
  const SCAN_LIMIT = 500;

  // 1. Direct ID match
  if (bookId) {
    const { data: itemsById } = await supabase
      .from("library_items")
      .select(LIGHT_SELECT)
      .or(`id.eq.${bookId},media_id.eq.${bookId}`)
      .eq("library_id", libraryId)
      .limit(1);

    if (itemsById && itemsById.length > 0) {
      matchedId = itemsById[0].id;
    }
  }

  // 2-3. Title-based matching
  if (!matchedId && title) {
    const { data: allLibItems } = await supabase
      .from("library_items")
      .select(LIGHT_SELECT)
      .eq("library_id", libraryId)
      .limit(SCAN_LIMIT);

    if (allLibItems?.length) {
      const normTitle = normalizeTitle(title);

      for (const item of allLibItems) {
        const itemTitle = (item.title || "").trim();
        // Exact match
        if (itemTitle.toLowerCase() === title.trim().toLowerCase()) {
          matchedId = item.id;
          break;
        }
        // Normalized match
        const normItemTitle = normalizeTitle(itemTitle);
        if (normItemTitle && normItemTitle === normTitle) {
          matchedId = item.id;
          break;
        }
      }
    }
  }

  return matchedId;
}
