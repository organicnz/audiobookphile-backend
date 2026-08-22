export interface ParsedTitleAuthor {
  cleanTitle: string;
  cleanAuthor: string;
}

/**
 * Intelligently separates combined book titles and author names.
 * Examples:
 * - "Christopher Hitchens - Hitch-22" -> Title: "Hitch-22", Author: "Christopher Hitchens"
 * - "Sagan, Carl -- The Demon-Haunted World" -> Title: "The Demon-Haunted World", Author: "Carl Sagan"
 * - "Alexei Navalny - 2024 - Patriot" -> Title: "Patriot", Author: "Alexei Navalny"
 * - "Essential CISSP by Phil Martin" -> Title: "Essential CISSP", Author: "Phil Martin"
 */
export function parseTitleAndAuthor(
  rawTitle: string,
  rawAuthor?: string,
): ParsedTitleAuthor {
  let title = (rawTitle || "").trim();
  let author = (rawAuthor || "").trim();

  if (author === "Unknown Author") {
    author = "";
  }

  // 1. If author is already known, strip author prefix/suffix from title if present
  if (author) {
    const escAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixRegex = new RegExp(`^${escAuthor}\\s*(?:--|-|:)\\s*`, "i");
    if (prefixRegex.test(title)) {
      title = title.replace(prefixRegex, "").trim();
    }
    const suffixRegex = new RegExp(`\\s*(?:--|-|by)\\s*${escAuthor}$`, "i");
    if (suffixRegex.test(title)) {
      title = title.replace(suffixRegex, "").trim();
    }
  }

  // 2. Handle "Last, First -- Title" or "Last, First - Title" (e.g., "Sagan, Carl -- The Demon-Haunted World")
  const lastFirstMatch = title.match(
    /^([\p{Lu}\p{Lt}][\p{L}'-]+),\s*([\p{Lu}\p{Lt}][\p{L}'\-.]+)\s*(?:--|-)\s*(.+)$/u,
  );
  if (lastFirstMatch) {
    const lastName = lastFirstMatch[1].trim();
    const firstName = lastFirstMatch[2].trim();
    const extractedTitle = lastFirstMatch[3].trim();
    const extractedAuthor = `${firstName} ${lastName}`;
    if (!author || author.toLowerCase() === extractedAuthor.toLowerCase()) {
      author = extractedAuthor;
      title = extractedTitle;
    }
  }

  // Author name pattern: 1-4 words starting with uppercase or initials, optional particles (de, van, von, etc.)
  const authorNamePattern =
    /^[\p{Lu}\p{Lt}][\p{L}'\-.]*(?:\s+(?:de|van|der|von|di|da|del|dos|du|[\p{Lu}\p{Lt}][\p{L}'\-.]*)){1,4}$/u;

  // 3. Handle "Author - Year - Title" or "Author - Title" (e.g. "Alexei Navalny - 2024 - Patriot", "Christopher Hitchens - Hitch-22")
  if (!author || title.includes(" - ") || title.includes(" -- ")) {
    const parts = title
      .split(/\s*(?:--|-)\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const firstPart = parts[0];
      const secondPart = parts[1];
      const isYear = /^(19|20)\d{2}$/.test(secondPart);

      const isFirstPartAuthor = authorNamePattern.test(firstPart);

      if (isFirstPartAuthor) {
        if (!author) author = firstPart;
        if (parts.length >= 3 && isYear) {
          title = parts.slice(2).join(" - ");
        } else {
          title = parts.slice(1).join(" - ");
        }
      } else {
        const lastPart = parts[parts.length - 1];
        const isLastPartAuthor = authorNamePattern.test(lastPart);
        if (isLastPartAuthor && !author) {
          author = lastPart;
          title = parts.slice(0, parts.length - 1).join(" - ");
        }
      }
    }
  }

  // 4. Handle "Title by Author" (e.g. "Essential CISSP by Phil Martin")
  const byMatch = title.match(
    /^(.+?)\s+by\s+([\p{Lu}\p{Lt}][\p{L}'\-.]*(?:\s+(?:de|van|der|von|di|da|del|dos|du|[\p{Lu}\p{Lt}][\p{L}'\-.]*))+)$/iu,
  );
  if (byMatch) {
    title = byMatch[1].trim();
    if (!author) {
      author = byMatch[2].trim();
    }
  }

  // Final sanity cleanups
  title = title.replace(/^[-–—:\s]+|[-–—:\s]+$/g, "").trim();
  if (!author) author = "Unknown Author";

  return { cleanTitle: title, cleanAuthor: author };
}

/**
 * Strips junk suffixes that scraped/provider data leaves on book titles
 * ("Mortality [96] Unabridged", "Discourses on Livy (1517)"). Subtitle,
 * series, and year are separate metadata fields, so trailing tokens like
 * `[<digits>]`, a standalone Unabridged/Abridged word, or a parenthesized
 * group of at most two words (genre/year/format tags) are redundant noise.
 * Longer parenthesized subtitles are kept. Mirrored in
 * audiobookphile-web/src/shared/utils/titleAuthorParser.ts.
 */
export function sanitizeDisplayTitle(title: string): string {
  let result = title.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const bracket = /\s*\[\d+\]\s*$/.exec(result);
    if (bracket) {
      result = result.slice(0, bracket.index).trim();
      changed = true;
    }
    const word = /\s+(?:unabridged|abridged)\s*$/i.exec(result);
    if (word) {
      result = result.slice(0, word.index).trim();
      changed = true;
    }
    const paren = /\s*\(\s*[^\s()]+(?:\s+[^\s()]+)?\s*\)\s*$/.exec(result);
    if (paren) {
      result = result.slice(0, paren.index).trim();
      changed = true;
    }
  }
  return result || title;
}

/**
 * Turns filename-derived titles into readable words:
 * "33TheThreeBodyProblemChapter33" → "33 The Three Body Problem Chapter 33".
 * Mirrored in audiobookphile-web/src/shared/utils/titleAuthorParser.ts.
 */
export function prettifyFilenameTitle(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}
