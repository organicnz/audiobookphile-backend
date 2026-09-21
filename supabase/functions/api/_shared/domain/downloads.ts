/**
 * Downloads Domain Module — Pure business logic for upload/download operations.
 *
 * Extracted from routes/downloads.ts to separate HTTP concerns from domain logic.
 * All functions are pure (given dependencies) and independently testable.
 */

import { parseTitleAndAuthor } from "../../../_shared/titleAuthorParser.ts";
import { titlesLikelySameWork } from "../../../_shared/titleMatch.ts";
import {
  matchExistingBookWithZAI,
  ZAI_CHAT_MODEL,
} from "../../../_shared/zai.ts";

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
 * Batch Structure Analysis — multi-work (franken-book) detection
 *
 * Born from the Dark Psychology incident: a source folder holding 4 distinct
 * books (Daniel Pratt 111 tracks, Martinez 29, Turner 26, Weiss 15) shares
 * one generic naming scheme ("Chapter N.mp3"). Merged into a single
 * library_item, same-named tracks overwrite each other in flat B2 keys
 * (`bookId/Chapter 1.mp3`) and collapse in filename-keyed dedup — producing
 * a franken-book with wrong order, wrong chapters, and a corrupt total.
 *
 * These helpers are pure string logic (no I/O, no LLM): they recover each
 * file's folder chain from its already-uploaded storagePath, group the batch
 * by top-level subfolder, and refuse batches whose basenames collide across
 * distinct non-disc folders. Multi-disc books (Disc 1 / CD02 …) are exempt.
 * ========================================================================= */

/** One upload batch entry's observable shape for structure analysis. */
export interface BatchFileShape {
  storagePath: string;
  name?: string;
}

/** Files sharing one top-level subfolder ("" = uploaded flat, no folder). */
export interface BatchGroup {
  folder: string;
  fileCount: number;
  sampleFiles: string[];
}

/** Verdict of the multi-work gate. */
export interface MultiWorkVerdict {
  /** True when the batch must be rejected (certain data loss on merge). */
  isMultiWork: boolean;
  groups: BatchGroup[];
  /** Lowercased basenames present in 2+ distinct non-disc folders. */
  collidingBasenames: string[];
}

/** Strip a `tier://` scheme prefix and leading slashes → bare storage key. */
export function stripStorageScheme(path: string): string {
  return String(path || "")
    .replace(/^[a-z0-9-_]+:\/\//i, "")
    .replace(/^\/+/, "");
}

/**
 * Recover a file's key relative to its book folder: strip the scheme and a
 * leading `<bookId>/` segment, drop `.`/`..`/empty segments (path-traversal
 * hardening), URI-decode the rest for stable grouping. Returns "" when
 * nothing usable remains. NEVER rewrites the stored storagePath — the object
 * already lives at that key; this is only the recorded grouping identity.
 */
export function deriveRelKey(storagePath: string, bookId = ""): string {
  let key = stripStorageScheme(storagePath);
  if (bookId) {
    if (key === bookId) return "";
    const prefix = `${bookId}/`;
    if (key.startsWith(prefix)) key = key.slice(prefix.length);
  }
  const segments: string[] = [];
  for (const raw of key.split("/")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") continue;
    try {
      segments.push(decodeURIComponent(trimmed));
    } catch {
      segments.push(trimmed);
    }
  }
  return segments.join("/");
}

/** Top-level subfolder of a relKey ("" when the file sits at the book root). */
export function topFolderOf(relKey: string): string {
  const idx = relKey.indexOf("/");
  return idx === -1 ? "" : relKey.slice(0, idx);
}

/**
 * Disc-like folder names belong to ONE multi-disc work ("Disc 1", "CD02",
 * "Part 3", "Volume 1", "Bonus") — never a signal of distinct books.
 */
export function isDiscLikeFolder(name: string): boolean {
  return /^(disc|disk|cd|part|pt|vol|volume|bonus|side)[\s._-]*\d*$/i.test(
    name.trim(),
  );
}

/**
 * Gate an upload batch: group files by top-level subfolder and flag basename
 * collisions across distinct folders. A collision is certain data loss
 * (flat-key overwrite + dedup collapse), so any basename present in 2+
 * folders where at least one holder is NOT disc-like ⇒ multi-work.
 */
export function detectMultiWorkBatch(
  files: BatchFileShape[],
  bookId = "",
): MultiWorkVerdict {
  const groupMap = new Map<string, { count: number; samples: string[] }>();
  const holders = new Map<string, Set<string>>();

  for (const f of files) {
    const relKey = deriveRelKey(f.storagePath, bookId);
    const parts = relKey ? relKey.split("/") : [];
    const rawBase = parts.length > 0
      ? parts[parts.length - 1]
      : String(f.name || "").split("/").pop() || "";
    const basename = rawBase.trim();
    const folder = topFolderOf(relKey);

    const g = groupMap.get(folder) ?? { count: 0, samples: [] };
    g.count++;
    if (g.samples.length < 3 && basename) g.samples.push(basename);
    groupMap.set(folder, g);

    const key = basename.toLowerCase();
    if (!key) continue;
    if (!holders.has(key)) holders.set(key, new Set());
    holders.get(key)!.add(folder);
  }

  const collidingBasenames: string[] = [];
  for (const [base, folders] of holders) {
    if (folders.size < 2) continue;
    // Exempt only when EVERY holder is disc-like (true multi-disc book).
    if ([...folders].every(isDiscLikeFolder)) continue;
    collidingBasenames.push(base);
  }
  collidingBasenames.sort();

  const groups: BatchGroup[] = [...groupMap.entries()].map(
    ([folder, g]) => ({
      folder,
      fileCount: g.count,
      sampleFiles: g.samples,
    }),
  ).sort((a, b) => b.fileCount - a.fileCount);

  return {
    isMultiWork: collidingBasenames.length > 0,
    groups,
    collidingBasenames: collidingBasenames.slice(0, 10),
  };
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
 * 4. Author + Title substring match.
 * 5. Z.ai semantic match for fuzzy cases (when API key available).
 *
 * Returns the matched item's `id` or `null`.
 */
export async function checkDuplicateBook(
  supabase: any,
  title: string,
  author: string,
  libraryId: string,
  zaiApiKey: string,
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

  // 2-5. Title & Author matching
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
        if (
          normItemTitle && normTitle &&
          normItemTitle.length >= 6 && normTitle.length >= 6 &&
          (normItemTitle.startsWith(normTitle) ||
            normTitle.startsWith(normItemTitle))
        ) {
          const itemAuthor = (item.author_names_first_last || "").toLowerCase()
            .replace(/[^\p{L}\p{N}]/gu, "");
          const uploadAuthor = (author || "").toLowerCase().replace(
            /[^\p{L}\p{N}]/gu,
            "",
          );
          if (
            itemAuthor && uploadAuthor &&
            (itemAuthor === uploadAuthor ||
              itemAuthor.includes(uploadAuthor) ||
              uploadAuthor.includes(itemAuthor))
          ) {
            matchedId = item.id;
            break;
          }
        }
      }

      if (!matchedId && zaiApiKey) {
        matchedId = await matchExistingBookWithZAI(
          title,
          author,
          allLibItems,
          zaiApiKey,
        );
      }
    }
  }

  return matchedId;
}

/**
 * Check for an existing duplicate book and return the hydrated item record.
 */
export async function findDuplicateBook(
  supabase: any,
  title: string,
  author: string,
  libraryId: string,
  zaiApiKey: string,
  bookId?: string,
): Promise<any | null> {
  const matchedId = await checkDuplicateBook(
    supabase,
    title,
    author,
    libraryId,
    zaiApiKey,
    bookId,
  );

  if (!matchedId) return null;

  const { data: fullItem } = await supabase
    .from("library_items")
    .select(
      "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
    )
    .eq("id", matchedId)
    .eq("library_id", libraryId)
    .limit(1)
    .maybeSingle();

  return fullItem || null;
}
