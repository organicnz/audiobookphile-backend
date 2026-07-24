// Shared Z.AI (GLM-4) AI integration module for sorting, matching, metadata enrichment, and chapter insights

const cacheMap = new Map<string, { result: any; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute in-memory TTL

function getCachedResult<T>(key: string): T | null {
  const cached = cacheMap.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    cacheMap.delete(key);
    return null;
  }
  return cached.result as T;
}

function setCachedResult<T>(key: string, result: T): void {
  cacheMap.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function naturalSortFilenames(filenames: string[]): string[] {
  return [...filenames].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
}

function extractJsonArray(text: string): string[] | null {
  if (!text) return null;
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (
      Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ) {
      return parsed as string[];
    }
  } catch (_e) {
    // Return null on parse error
  }
  return null;
}

/**
 * Optimizes the sorting of audiobook chapter/track filenames into exact narrative chronological order using Z.AI (GLM-4).
 * Handles multi-disc structures (Disc 1, CD 02), track numbers, multi-part chapters, prologues, epilogues, and bonus content.
 */
export async function sortFilesWithZAI(
  filenames: string[],
  zaiApiKey: string,
): Promise<string[]> {
  if (filenames.length <= 1) return filenames;
  if (!zaiApiKey) return naturalSortFilenames(filenames);

  const cacheKey = `sort_files_${filenames.join("||")}`;
  const cached = getCachedResult<string[]>(cacheKey);
  if (cached) {
    console.log(
      `[z.ai] Cache hit for ${filenames.length} track sequence sorting.`,
    );
    return cached;
  }

  try {
    const prompt =
      `You are an expert audiobook librarian. Sort these audiobook chapter/track filenames into exact narrative chronological reading order.
Consider:
1. Multi-disc structures (e.g., Disc 1, CD01, Disc 2) precede track/chapter numbers.
2. Prologues, Prefaces, and Introductions come before Chapter 1.
3. Track and Chapter numbers in sequence.
4. Epilogues, Afterwords, and Bonus Tracks come after final chapters.

Filenames to sort:
${JSON.stringify(filenames)}

Return ONLY a valid JSON array of strings containing every exact filename in chronological order: ["file1.mp3", "file2.mp3", ...]`;

    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.0,
        }),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      const sortedList = extractJsonArray(content);
      if (
        sortedList &&
        sortedList.length === filenames.length &&
        new Set(sortedList).size === filenames.length &&
        filenames.every((f) => sortedList.includes(f))
      ) {
        console.log(
          `[z.ai] Successfully optimized chapter sequence sorting for ${filenames.length} tracks.`,
        );
        setCachedResult(cacheKey, sortedList);
        return sortedList;
      }
    }
  } catch (err: unknown) {
    const e = err as Error;
    console.warn("[z.ai] Chapter sorting fallback to natural sort:", e.message);
  }

  return naturalSortFilenames(filenames);
}

/**
 * Checks if an uploading book (title & author) semantically matches any existing book record in the library.
 * Returns the matching existing item ID or null if no match.
 */
export async function matchExistingBookWithZAI(
  uploadTitle: string,
  uploadAuthor: string,
  existingBooks: {
    id: string;
    title?: string | null;
    author_names_first_last?: string | null;
  }[],
  zaiApiKey: string,
): Promise<string | null> {
  if (
    !uploadTitle || !existingBooks || existingBooks.length === 0 || !zaiApiKey
  ) {
    return null;
  }

  const cacheKey =
    `match_book_${uploadTitle.toLowerCase().trim()}||${uploadAuthor.toLowerCase().trim()}||${
      existingBooks.map((b) => b.id).join(",")
    }`;
  const cachedMatch = getCachedResult<string | null>(cacheKey);
  if (cachedMatch !== null) {
    return cachedMatch;
  }

  try {
    const candidates = existingBooks.map((b) => ({
      id: b.id,
      title: b.title || "",
      author: b.author_names_first_last || "Unknown",
    }));

    const prompt =
      `An audiobook is being uploaded with Title: "${uploadTitle}" and Author: "${
        uploadAuthor || "Unknown"
      }".
Compare it against this list of existing books in the library:
${JSON.stringify(candidates)}

Determine if the uploading book is the same book as any candidate in the list (considering subtitle variations, edition names, narrator tags, or minor formatting differences).
If it matches an existing book, return ONLY a JSON object with the matching ID: {"matchedId": "ID"}.
If it is a completely new/different book, return: {"matchedId": null}`;

    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      const cleaned = content.replace(/```json\s*/gi, "").replace(/```\s*/g, "")
        .trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        const result = JSON.parse(match[0]);
        if (
          result.matchedId &&
          existingBooks.some((b) => b.id === result.matchedId)
        ) {
          console.log(
            `[z.ai] Matched uploading book "${uploadTitle}" to existing record ID: ${result.matchedId}`,
          );
          setCachedResult(cacheKey, result.matchedId);
          return result.matchedId;
        }
      }
    }
  } catch (err: unknown) {
    const e = err as Error;
    console.warn("[z.ai] Book matching error:", e.message);
  }

  return null;
}

/**
 * Optimizes the sorting of library items (books) by a given criteria (e.g. chronological reading order, series order).
 * Guarantees all input IDs are present in the returned array.
 */
export async function smartSortLibraryItems(
  items: {
    id: string;
    title?: string | null;
    author_names_first_last?: string | null;
    published_year?: string | null;
  }[],
  criteria: string,
  zaiApiKey: string,
): Promise<string[]> {
  if (!items || items.length === 0) return [];
  const defaultSortedIds = [...items]
    .sort((a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { numeric: true })
    )
    .map((i) => i.id);

  if (items.length <= 1 || !zaiApiKey) return defaultSortedIds;

  const cacheKey = `smart_sort_${criteria}||${
    items.map((i) => i.id).join(",")
  }`;
  const cachedSort = getCachedResult<string[]>(cacheKey);
  if (cachedSort) {
    console.log(`[z.ai] Cache hit for smart sort by criteria: "${criteria}"`);
    return cachedSort;
  }

  try {
    const payload = items.map((i) => ({
      id: i.id,
      title: i.title || "",
      author: i.author_names_first_last || "",
      year: i.published_year || "",
    }));

    const prompt = `Given the following audiobooks:
${JSON.stringify(payload)}

Sort them intelligently according to criteria: "${criteria}".
Return ONLY a valid JSON array of string IDs representing the sorted order: ["id1", "id2", ...]`;

    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      const sortedIds = extractJsonArray(content);
      if (sortedIds && sortedIds.length > 0) {
        const missingIds = defaultSortedIds.filter((id) =>
          !sortedIds.includes(id)
        );
        const validSortedIds = sortedIds.filter((id) =>
          defaultSortedIds.includes(id)
        );
        const finalSorted = [...validSortedIds, ...missingIds];
        setCachedResult(cacheKey, finalSorted);
        return finalSorted;
      }
    }
  } catch (err: unknown) {
    const e = err as Error;
    console.warn("[z.ai] Library smart-sort error:", e.message);
  }

  return defaultSortedIds;
}

/**
 * Enriches audiobook metadata (description, genres, published year) using Z.AI (GLM-4).
 */
export async function enrichMetadataWithZAI(
  title: string,
  author: string,
  zaiApiKey: string,
): Promise<
  { description?: string; genres?: string[]; publishedYear?: string } | null
> {
  if (!title || !zaiApiKey) return null;

  const cacheKey = `enrich_meta_${title.toLowerCase().trim()}||${
    (author || "").toLowerCase().trim()
  }`;
  const cachedMeta = getCachedResult<
    { description?: string; genres?: string[]; publishedYear?: string }
  >(cacheKey);
  if (cachedMeta) return cachedMeta;

  try {
    const res = await fetch(
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
              `Provide accurate executive summary (description), top 3 genres/tags, and published year for the audiobook "${title}" by "${
                author || "Unknown"
              }". Return ONLY a JSON object: {"description": "...", "genres": ["..."], "publishedYear": "YYYY"}`,
          }],
          temperature: 0.2,
        }),
      },
    );

    if (res.ok) {
      const aiData = await res.json();
      const text = aiData.choices?.[0]?.message?.content || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const result = JSON.parse(match[0]);
        setCachedResult(cacheKey, result);
        return result;
      }
    }
  } catch (err: unknown) {
    const e = err as Error;
    console.warn("[z.ai] Metadata enrichment error:", e.message);
  }

  return null;
}

/**
 * Generates chapter executive summary, key takeaways, and mood insights using Z.AI (GLM-4).
 */
export async function generateChapterAIInsights(
  title: string,
  author: string,
  chapterTitle: string,
  chapterIndex: number | undefined,
  zaiApiKey: string,
): Promise<{ summary: string; keyTakeaways: string[]; mood: string }> {
  const fallback = {
    summary: chapterTitle,
    keyTakeaways: [],
    mood: "Engaging",
  };
  if (!title || !chapterTitle || !zaiApiKey) return fallback;

  const cacheKey = `chapter_insights_${title.toLowerCase().trim()}||${
    chapterIndex ?? 0
  }||${chapterTitle.toLowerCase().trim()}`;
  const cachedInsights = getCachedResult<
    { summary: string; keyTakeaways: string[]; mood: string }
  >(cacheKey);
  if (cachedInsights) return cachedInsights;

  try {
    const prompt = `You are an expert literary scholar and audiobook companion. 
Provide a concise, high-level executive summary and key takeaways for Chapter ${
      chapterIndex ?? ""
    }: "${chapterTitle}" from the audiobook "${title}" by ${
      author || "Unknown Author"
    }.

Format response in valid JSON with key "summary" (2-3 sentences), "keyTakeaways" (array of 3 bullet strings), and "mood" (string).`;

    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [
            {
              role: "system",
              content: "You respond strictly in valid JSON format.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
        }),
      },
    );

    if (res.ok) {
      const zaiData = await res.json();
      const rawContent = zaiData.choices?.[0]?.message?.content ?? "{}";
      const cleaned = rawContent.replace(/```json\s*/gi, "").replace(
        /```\s*/g,
        "",
      ).trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const result = {
          summary: parsed.summary || fallback.summary,
          keyTakeaways: Array.isArray(parsed.keyTakeaways)
            ? parsed.keyTakeaways
            : [],
          mood: parsed.mood || "Engaging",
        };
        setCachedResult(cacheKey, result);
        return result;
      }
    }
  } catch (err: unknown) {
    const e = err as Error;
    console.warn("[z.ai] Chapter AI insights error:", e.message);
  }

  return fallback;
}
