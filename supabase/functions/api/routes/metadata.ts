import { z } from "zod";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";
import { enrichMetadataWithZAI } from "../../_shared/zai.ts";

export const metadataRouter = new Hono<{ Variables: Variables }>();

// ===== Zod schemas for metadata endpoints =====
const MatchBookSchema = z.object({
  title: z.string().min(1, "Title is required").max(256),
  author: z.string().optional(), // optional alias - we'll use it in fallback search
});

const ScrapeMetadataBodySchemaWithOptionalTitle = z.object({
  title: z.string().max(256).or(z.literal("")),
  bookTitle: z.string().optional(),
  author: z.string().optional(),
  authorName: z.string().optional(),
});

// Global metadata maintenance (narrators/tags/genres CRUD, external match &
// scrape) touches server-wide content — strictly admin/root only. Guards are
// bound to the router's own patterns (NOT "*") so they never intercept other
// routers mounted under /api.
const adminGuard: MiddlewareHandler<{ Variables: Variables }> = async (
  c,
  next,
) => {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  await next();
};

for (
  const pattern of [
    "/narrators/:id",
    "/tags/:id",
    "/genres/:id",
    "/match-book",
    "/scrape-metadata",
    "/metadata/scrape",
  ]
) {
  metadataRouter.use(pattern, adminGuard);
}

// --- NARRATORS ---
metadataRouter.patch("/narrators/:id", async (c) => {
  return c.json(
    { error: "Not implemented (narrators table does not exist)" },
    501,
  );
});

metadataRouter.delete("/narrators/:id", async (c) => {
  return c.json(
    { error: "Not implemented (narrators table does not exist)" },
    501,
  );
});

// --- TAGS ---
metadataRouter.delete("/tags/:id", async (c) => {
  return c.json({ error: "Not implemented (tags table does not exist)" }, 501);
});

// --- GENRES ---
metadataRouter.delete("/genres/:id", async (c) => {
  return c.json(
    { error: "Not implemented (genres table does not exist)" },
    501,
  );
});

// --- MATCH BOOK METADATA ---
metadataRouter.post("/match-book", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    // If no JSON body at all, fall back to query params with strict validation
    const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);
    if (!queryParams.title || !queryParams.title.trim()) {
      return c.json({ error: "Title is required" }, 400);
    }
    const parsed = MatchBookSchema.safeParse(queryParams);
    if (parsed.success) {
      body = parsed.data;
    } else {
      return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
    }
  }

  // Validate with Zod schema
  const parsed = MatchBookSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const title = parsed.data.title;
  const author = parsed.data.author || "";

  try {
    const results: any[] = [];
    // Open Library search
    const query = new URLSearchParams({ title, limit: "5" });
    if (author) query.set("author", author);

    const olRes = await fetch(
      `https://openlibrary.org/search.json?${query.toString()}`,
      { signal: AbortSignal.timeout(8000) },
    );

    if (olRes.ok) {
      const data = await olRes.json();
      const docs = (data?.docs as any[]) || [];
      for (const doc of docs.slice(0, 5)) {
        const authorNames: string[] = doc.author_name || [];
        results.push({
          title: doc.title || title,
          author: authorNames[0] || author || "",
          description: doc.first_sentence?.value || "",
          cover: doc.cover_i
            ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
            : undefined,
          series: [],
          genres: doc.subject?.slice(0, 3) || [],
          tags: [],
          isbn: doc.isbn?.[0] || undefined,
          asin: undefined,
          language: doc.language?.[0] || undefined,
          publisher: doc.publisher?.[0] || undefined,
          publishedYear: doc.first_publish_year
            ? String(doc.first_publish_year)
            : undefined,
          narrator: undefined,
          explicit: false,
          abridged: false,
        });
      }
    }

    // Google Books fallback
    if (results.length === 0) {
      const q = author
        ? `intitle:${title}+inauthor:${author}`
        : `intitle:${title}`;
      const gbRes = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${
          encodeURIComponent(q)
        }&maxResults=5&printType=books`,
        {
          signal: AbortSignal.timeout(8000),
        },
      );
      if (gbRes.ok) {
        const data = await gbRes.json();
        const items = (data?.items as any[]) || [];
        for (const item of items.slice(0, 5)) {
          const info = item.volumeInfo || {};
          const thumbnail =
            info.imageLinks?.thumbnail?.replace("http://", "https://") ||
            undefined;
          results.push({
            title: info.title || title,
            author: info.authors?.[0] || author || "",
            description: info.description || "",
            cover: thumbnail,
            series: [],
            genres: info.categories?.slice(0, 3) || [],
            tags: [],
            isbn: info.industryIdentifiers?.find((i: any) =>
              i.type === "ISBN_13"
            )?.identifier || undefined,
            asin: undefined,
            language: info.language || undefined,
            publisher: info.publisher || undefined,
            publishedYear: info.publishedDate?.slice(0, 4) || undefined,
            narrator: undefined,
            explicit: false,
            abridged: false,
          });
        }
      }
    }

    // Z.AI GLM-4 Fallback Matcher
    if (results.length === 0) {
      const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
        Deno.env.get("ZHIPU_API_KEY") ?? "";
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
                model: "glm-4-flash",
                messages: [
                  {
                    role: "user",
                    content:
                      `Provide accurate metadata for the audiobook "${title}" by "${
                        author || "Unknown"
                      }". Return ONLY a JSON object: {"title": "...", "author": "...", "description": "...", "genres": ["..."], "publishedYear": "YYYY"}`,
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
              const parsed = JSON.parse(match[0]);
              results.push({
                title: parsed.title || title,
                author: parsed.author || author || "",
                description: parsed.description || "",
                cover: undefined,
                series: [],
                genres: parsed.genres || [],
                tags: [],
                publishedYear: parsed.publishedYear || undefined,
                explicit: false,
                abridged: false,
              });
            }
          }
        } catch (_e) {
          // Ignore
        }
      }
    }

    return c.json({ results });
  } catch (err: any) {
    console.error("[metadata] match-book failed:", err);
    return c.json({ error: "Failed to fetch metadata" }, 500);
  }
});

async function handleScrapeMetadata(c: any) {
  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    // If no JSON body at all, fall back to query params with strict validation
    const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);
    if (!queryParams.title && !queryParams.bookTitle) {
      return c.json({ error: "Title is required" }, 400);
    }
    const parsed = ScrapeMetadataBodySchemaWithOptionalTitle.safeParse(
      queryParams,
    );
    if (parsed.success) {
      body = parsed.data;
    } else {
      return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
    }
  }

  // Validate with Zod schema (title is required for ZAI enrichment)
  const parsed = ScrapeMetadataBodySchemaWithOptionalTitle.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  let title = parsed.data.title || parsed.data.bookTitle || "";
  if (title === "") {
    // Empty string is technically allowed by schema but we want to prevent empty requests
    // Only allow empty body for legacy compatibility - still requires actual enrichment data
    return c.json({ error: "Title is required" }, 400);
  }

  const author = parsed.data.author || parsed.data.authorName || "";

  if (!title) {
    return c.json({ error: "Title is required" }, 400);
  }

  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";
  try {
    const enriched = await enrichMetadataWithZAI(title, author, zaiApiKey);
    return c.json({ success: true, metadata: enriched || { title, author } });
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to scrape metadata" }, 500);
  }
}

metadataRouter.post("/scrape-metadata", handleScrapeMetadata);
metadataRouter.post("/metadata/scrape", handleScrapeMetadata);
