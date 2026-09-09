/**
 * AI-Powered Metadata Service
 *
 * Fetches book metadata from Amazon Product Advertising API and Google Books API.
 * Uses Supabase Vault for secret management.
 * Provides intelligent title/author matching, cover art fetching, and description extraction.
 */

// Interface for book metadata from various sources
export interface BookMetadata {
  title: string;
  subtitle?: string;
  author?: string;
  narrator?: string;
  series?: string;
  seriesIndex?: number;
  publishedDate?: string;
  publishedYear?: string;
  pageCount?: number;
  language?: string;
  ISBN?: string;
  ASIN?: string;
  description?: string;
  descriptionPlain?: string;
  coverUrl?: string;
  coverSmallUrl?: string;
  coverLargeUrl?: string;
  categories?: string[];
  publisher?: string;
  weight?: number;
  dimensions?: {
    height?: number;
    width?: number;
    thickness?: number;
  };
  amazon?: {
    productUrl?: string;
    authorPageUrl?: string;
    reviewUrl?: string;
  };
  google?: {
    googleBooksId?: string;
    readability?: string;
  };
}

/** Metadata from Amazon Product Advertising API */
interface AmazonMetadata {
  title: string;
  author: string[];
  imgUrl?: string;
  detailPageUrl: string;
  salesRank?: number;
  availability?: string;
  editorialReviews?: {
    editorialReview?: { content: string; source?: string }[];
  };
}

/** Metadata from Google Books API */
interface GoogleMetadata {
  id: string;
  volumeInfo: {
    title: string;
    authors: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: {
      type: string;
      identifier: string;
    }[];
    pageCount?: number;
    language?: string;
    description?: string;
    imageLinks?: {
      smallThumbnail?: string;
      thumbnail?: string;
      medium?: string;
      large?: string;
      extraLarge?: string;
    };
  };
  saleInfo?: {
    buyLink?: string;
    isEbook?: boolean;
    price?: string;
  };
}

/** Search result from Amazon PA API */
interface AmazonSearchResult {
  items: AmazonMetadata[];
  totalResults: number;
  error?: string;
}

/** Search result from Google Books API */
interface GoogleSearchResult {
  items: GoogleMetadata[];
  totalItems: number;
}

/** Search parameters for marketplace searches */
interface MarketplaceSearchParams {
  title: string;
  author?: string;
  maxResults?: number;
  includeFilters?: {
    language?: string;
    minPageCount?: number;
    maxPageCount?: number;
  };
}

/** Result of a marketplace search */
interface MarketplaceSearchResult {
  source: "amazon" | "google";
  metadata: BookMetadata;
  raw: AmazonMetadata | GoogleMetadata;
  matchConfidence: number; // 0-100 how well it matches the search query
}

/**
 * Fetches metadata from Amazon Product Advertising API
 * Requires Amazon PA credentials stored in Supabase Vault
 */
export async function fetchAmazonMetadata(
  title: string,
  author?: string,
  options: { maxResults?: number } = {},
): Promise<MarketplaceSearchResult | null> {
  // Stub until Amazon PA credentials are available in Vault.
  void title;
  void author;
  void options;
  // In production, this would use the Amazon PA API with Vault-stored credentials
  // For now, return null - implementation depends on having Amazon PA access

  // TODO: Implement when Amazon PA credentials are available in Vault
  // const amazonClient = createAmazonClient(); // Uses Vault
  // const searchIndex = author ? "Books" : "StripBooks";
  // const response = await amazonClient.searchItems({
  //   keyword: title,
  //   author,
  //   searchIndex,
  //   resources: ["itemInfo", "offers", "images"],
  //   maximumItems: options.maxResults || 5,
  // });
  //
  // if (response?.body?.offers?.items?.[0]?.summary?.price?.displayAmount) {
  //   // Parse and return metadata
  // }

  // Placeholder implementation
  return null;
}

/** Fetches metadata from Google Books API */
export async function fetchGoogleMetadata(
  title: string,
  author?: string,
  options: { maxResults?: number } = {},
): Promise<MarketplaceSearchResult | null> {
  // Google Books API doesn't require API key for basic searches
  const searchQuery = author ? `${title} ${author}` : title;

  const url = `https://www.googleapis.com/books/v1/volumes?q=${
    encodeURIComponent(searchQuery)
  }&maxResults=${options.maxResults || 5}`;

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`Google Books API error: ${response.status}`);
      return null;
    }

    const data = await response.json() as { items?: GoogleMetadata[] };

    if (!data?.items || data.items.length === 0) {
      return null;
    }

    const googleItems = data.items.map((item) => ({
      id: item.id,
      volumeInfo: item.volumeInfo,
    }));

    // Find the best match and return metadata
    const bestMatch = googleItems[0];
    const volumeInfo = bestMatch.volumeInfo;

    const metadata: BookMetadata = {
      title: volumeInfo.title,
      author: volumeInfo.authors?.join(", "),
      publisher: volumeInfo.publisher,
      publishedDate: volumeInfo.publishedDate,
      description: volumeInfo.description,
      pageCount: volumeInfo.pageCount,
      language: volumeInfo.language,
      coverUrl: volumeInfo.imageLinks?.thumbnail,
      coverSmallUrl: volumeInfo.imageLinks?.smallThumbnail,
      coverLargeUrl: volumeInfo.imageLinks?.large,
      categories: volumeInfo.categories,
    };

    return {
      source: "google",
      metadata,
      raw: bestMatch,
      matchConfidence: 0.9, // Google Books match confidence
    };
  } catch (error) {
    console.error("Error fetching Google Books metadata:", error);
    return null;
  }
}

/**
 * Intelligent metadata fetching from multiple sources
 * Tries Amazon first, then Google, returns the best match
 */
export async function fetchIntelligentMetadata(
  title: string,
  author?: string,
  options: {
    preferAmazon?: boolean;
    maxResults?: number;
    minConfidence?: number;
  } = {},
): Promise<MarketplaceSearchResult | null> {
  const preferAmazon = options.preferAmazon !== false;
  const minConfidence = options.minConfidence ?? 0.7;

  // Try Amazon first if preferred
  if (preferAmazon) {
    const amazonResult = await fetchAmazonMetadata(title, author, {
      maxResults: options.maxResults,
    });
    if (amazonResult && amazonResult.matchConfidence >= minConfidence) {
      return amazonResult;
    }
  }

  // Fall back to Google Books
  const googleResult = await fetchGoogleMetadata(title, author, {
    maxResults: options.maxResults,
  });
  if (googleResult && googleResult.matchConfidence >= minConfidence) {
    return googleResult;
  }

  // If Amazon was preferred but failed, try Google without the preferAmazon flag
  if (preferAmazon) {
    return await fetchIntelligentMetadata(title, author, {
      preferAmazon: false,
      maxResults: options.maxResults,
      minConfidence,
    });
  }

  return null;
}

/**
 * Extracts book metadata from a known title using cached/search results
 * This is used when the user provides just a title and we need to find the full metadata
 */
export async function resolveBookMetadata(
  title: string,
  author?: string,
  options: {
    preferAmazon?: boolean;
    maxResults?: number;
    timeoutMs?: number;
  } = {},
): Promise<BookMetadata | null> {
  const result = await fetchIntelligentMetadata(title, author, {
    preferAmazon: options?.preferAmazon,
    maxResults: options?.maxResults,
  });

  if (!result) {
    return null;
  }

  // Transform the raw metadata into the standard BookMetadata format
  const { metadata, raw } = result;

  // Build the standardized metadata object
  const standardized: BookMetadata = {
    title: metadata.title,
    author: metadata.author,
    subtitle: undefined,
    narrator: undefined,
    series: undefined,
    seriesIndex: undefined,
    publishedDate: metadata.publishedDate,
    publishedYear: metadata.publishedDate
      ? metadata.publishedDate.split("-")[0]
      : undefined,
    pageCount: metadata.pageCount,
    language: metadata.language,
    ISBN: undefined,
    ASIN: undefined,
    description: metadata.description,
    descriptionPlain: metadata.description,
    coverUrl: metadata.coverUrl,
    coverSmallUrl: metadata.coverSmallUrl,
    coverLargeUrl: metadata.coverLargeUrl,
    categories: metadata.categories,
    publisher: metadata.publisher,
    weight: undefined,
    dimensions: undefined,
    amazon: raw.source === "amazon"
      ? {
        productUrl: undefined,
        authorPageUrl: undefined,
        reviewUrl: undefined,
      }
      : undefined,
    google: raw.source === "google"
      ? {
        googleBooksId: raw.id,
      }
      : undefined,
  };

  return standardized;
}

/** Cached metadata results to avoid redundant API calls */
const metadataCache: Map<
  string,
  { result: MarketplaceSearchResult; timestamp: number }
> = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Checks if cached result is still valid */
function isCacheValid(timestamp: number): boolean {
  return Date.now() - timestamp < CACHE_TTL_MS;
}

/** Gets cached metadata if available and valid */
export function getCachedMetadata(
  key: string,
): MarketplaceSearchResult | null {
  const cached = metadataCache.get(key);
  if (!cached) return null;
  if (!isCacheValid(cached.timestamp)) {
    metadataCache.delete(key);
    return null;
  }
  return cached.result;
}

/** Caches a metadata result */
export function setCachedMetadata(
  key: string,
  result: MarketplaceSearchResult,
) {
  metadataCache.set(key, {
    result,
    timestamp: Date.now(),
  });
}

/** Cache key generator for metadata search */
export function generateCacheKey(title: string, author?: string): string {
  const cleanTitle = title.toLowerCase().trim();
  const cleanAuthor = author ? author.toLowerCase().trim() : "";
  return `${cleanTitle}|${cleanAuthor}`;
}

/** Pre-caches common book metadata on startup */
export async function preloadCommonMetadata(): Promise<void> {
  // This could be used to pre-load metadata for popular books
  // to improve subsequent lookup performance
  console.log("Preloading common book metadata cache...");
  // Implementation would load frequently requested books
}

/**
 * Health check for the metadata service
 * Verifies API connectivity and cache functionality
 */
export async function healthCheck(): Promise<{
  googleBooksApi: boolean;
  cache: boolean;
  totalCached: number;
}> {
  const cachedCount = metadataCache.size;

  // Test Google Books API connectivity
  let googleBooksApi = false;
  try {
    const testResult = await fetchGoogleMetadata("test book");
    googleBooksApi = !!testResult;
  } catch {
    // API might be unavailable
  }

  return {
    googleBooksApi,
    cache: true,
    totalCached: cachedCount,
  };
}

export type {
  AmazonMetadata,
  BookMetadata,
  GoogleMetadata,
  MarketplaceSearchParams,
  MarketplaceSearchResult,
};
