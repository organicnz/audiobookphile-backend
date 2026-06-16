/**
 * Cover image and metadata fetching from external providers.
 *
 * Tries providers in order:
 *   1. iTunes Search API (highest quality for audiobooks)
 *   2. Open Library (free, no key)
 *   3. Google Books (free, no key for basic search)
 *
 * Returns the cover image data and metadata, or null if not found.
 */

export interface FetchedCover {
  buffer: ArrayBuffer;
  contentType: string;
  extension: string;
}

export interface BookMetadata {
  title: string;
  author?: string;
  description?: string;
  publishedYear?: string;
  genres?: string[];
  publisher?: string;
  language?: string;
}

export interface FetchResult {
  cover: FetchedCover | null;
  metadata: BookMetadata | null;
}

/**
 * Aggressively cleans up messy titles/authors for better API matching.
 */
function normalizeString(str: string): string {
  if (!str) return "";

  let cleaned = str
    // 1. Split CamelCase/PascalCase
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // 2. Remove bracketed content
    .replace(/\[[^\]]*\]/g, " ")
    // 3. Remove parenthesized content
    .replace(/\([^)]*\)/g, " ")
    // 4. Replace dots, underscores, and dashes with spaces
    .replace(/[\._-]/g, " ")
    // 5. Remove common audiobook suffixes
    .replace(
      /\b(audiobook|unabridged|abridged|collection|series|vol|volume|book|complete|part|chapter|of|v\d+)\b/gi,
      " ",
    )
    // 6. Clean up extra whitespace
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

function parseRawTitle(
  rawTitle: string,
): { cleanTitle: string; extractedAuthor?: string } {
  let title = rawTitle;
  let author: string | undefined = undefined;

  if (title.includes(" -- ")) {
    const parts = title.split(" -- ");
    author = normalizeString(parts[0]);
    title = normalizeString(parts[1]);
  } else if (title.includes(" - ")) {
    const parts = title.split(" - ");
    author = normalizeString(parts[0]);
    title = normalizeString(parts[1]);
  } else {
    title = normalizeString(title);
  }

  return { cleanTitle: title, extractedAuthor: author };
}

function getExtensionFromType(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Fetch a cover image for a book by title and/or author.
 */
export async function fetchBookCover(
  title: string,
  author?: string,
): Promise<FetchedCover | null> {
  const result = await fetchBookMetadata(title, author);
  return result.cover;
}

/**
 * Fetch full metadata and cover for a book.
 * Uses a multi-pass strategy to maximize match chances even with noisy metadata.
 */
export async function fetchBookMetadata(
  title: string,
  author?: string,
): Promise<FetchResult> {
  const { cleanTitle, extractedAuthor } = parseRawTitle(title);
  const cleanAuthor = author ? normalizeString(author) : extractedAuthor;

  const strategies = [
    { title: cleanTitle, author: cleanAuthor },
    { title: cleanTitle },
  ];

  const words = cleanTitle.split(" ");
  if (words.length > 5) {
    strategies.push({ title: words.slice(0, 4).join(" ") });
  }

  const providers = [
    fetchFromITunes,
    fetchFromOpenLibrary,
    fetchFromGoogleBooks,
  ];

  for (const strategy of strategies) {
    if (!strategy.title) continue;

    for (const provider of providers) {
      try {
        const result = await provider(strategy.title, strategy.author);
        if (result && (result.cover || result.metadata)) return result;
      } catch (err) {
        console.warn(
          `[coverFetch] Provider failed for "${strategy.title}":`,
          err,
        );
      }
    }
  }

  return { cover: null, metadata: null };
}

async function fetchFromITunes(
  title: string,
  author?: string,
): Promise<FetchResult | null> {
  try {
    const queryTerm = author ? `${title} ${author}` : title;
    const searchRes = await fetch(
      `https://itunes.apple.com/search?term=${
        encodeURIComponent(queryTerm)
      }&media=audiobook&limit=1`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (searchRes.status === 429 || searchRes.status === 403) {
      throw new Error("RateLimitExceeded");
    }
    if (!searchRes.ok) return null;

    const data = await searchRes.json();
    if (!data?.results?.length) {
      if (author) return fetchFromITunes(title);
      return null;
    }

    const item = data.results[0];

    const metadata: BookMetadata = {
      title: item.trackName || title,
      author: item.artistName,
      description: item.description
        ? item.description.replace(/<[^>]*>/g, "")
        : undefined,
      publishedYear: item.releaseDate
        ? new Date(item.releaseDate).getFullYear().toString()
        : undefined,
      genres: item.primaryGenreName ? [item.primaryGenreName] : [],
    };

    let cover: FetchedCover | null = null;
    if (item.artworkUrl100) {
      const imgUrl = item.artworkUrl100.replace(
        "100x100bb.jpg",
        "600x600bb.jpg",
      );
      const imgRes = await fetch(imgUrl, {
        signal: AbortSignal.timeout(10000),
      });
      if (imgRes.ok) {
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        const buffer = await imgRes.arrayBuffer();
        if (buffer.byteLength > 3000) {
          cover = {
            buffer,
            contentType,
            extension: getExtensionFromType(contentType),
          };
        }
      }
    }

    return { cover, metadata };
  } catch {
    return null;
  }
}

async function fetchFromOpenLibrary(
  title: string,
  author?: string,
): Promise<FetchResult | null> {
  try {
    const queryTerm = author ? `${title} ${author}` : title;
    const query = new URLSearchParams({ q: queryTerm, limit: "3" });

    const searchRes = await fetch(
      `https://openlibrary.org/search.json?${query.toString()}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (searchRes.status === 429 || searchRes.status === 503) {
      throw new Error("RateLimitExceeded");
    }
    if (!searchRes.ok) return null;

    const data = await searchRes.json();
    const docs = data?.docs as any[];
    if (!docs?.length) return null;

    const withCover = docs.find((d) => d.cover_i) || docs[0];

    const metadata: BookMetadata = {
      title: withCover.title || title,
      author: withCover.author_name?.[0],
      publishedYear: withCover.first_publish_year?.toString(),
      genres: withCover.subject?.slice(0, 5),
    };

    let cover: FetchedCover | null = null;
    if (withCover.cover_i) {
      const imgRes = await fetch(
        `https://covers.openlibrary.org/b/id/${withCover.cover_i}-L.jpg`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (imgRes.ok) {
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        if (!contentType.includes("text/html")) {
          const buffer = await imgRes.arrayBuffer();
          if (buffer.byteLength > 3000) {
            cover = {
              buffer,
              contentType,
              extension: getExtensionFromType(contentType),
            };
          }
        }
      }
    }

    return { cover, metadata };
  } catch {
    return null;
  }
}

async function fetchFromGoogleBooks(
  title: string,
  author?: string,
): Promise<FetchResult | null> {
  try {
    const queryTerm = author ? `${title} ${author}` : title;
    const searchRes = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${
        encodeURIComponent(queryTerm)
      }&maxResults=3&printType=books`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (searchRes.status === 429) throw new Error("RateLimitExceeded");
    if (!searchRes.ok) return null;

    const data = await searchRes.json();
    const items = data?.items as any[];
    if (!items?.length) return null;

    const item = items.find((it) => it.volumeInfo?.imageLinks?.thumbnail) ||
      items[0];
    const info = item.volumeInfo;

    const metadata: BookMetadata = {
      title: info.title || title,
      author: info.authors?.[0],
      description: info.description
        ? info.description.replace(/<[^>]*>/g, "")
        : undefined,
      publishedYear: info.publishedDate
        ? info.publishedDate.split("-")[0]
        : undefined,
      publisher: info.publisher,
      genres: info.categories,
      language: info.language,
    };

    let cover: FetchedCover | null = null;
    if (info.imageLinks) {
      let imgUrl: string = info.imageLinks.extraLarge ||
        info.imageLinks.large ||
        info.imageLinks.thumbnail;

      imgUrl = imgUrl.replace("http://", "https://").replace("&edge=curl", "");

      const imgRes = await fetch(imgUrl, {
        signal: AbortSignal.timeout(10000),
      });
      if (imgRes.ok) {
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        const buffer = await imgRes.arrayBuffer();
        if (buffer.byteLength > 3000) {
          cover = {
            buffer,
            contentType,
            extension: getExtensionFromType(contentType),
          };
        }
      }
    }

    return { cover, metadata };
  } catch {
    return null;
  }
}
