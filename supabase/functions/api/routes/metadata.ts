import { Hono } from "hono";

import { Variables } from "../_shared/types.ts";
export const metadataRouter = new Hono<{ Variables: Variables }>();

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
  const { title, author } = await c.req.json();
  if (!title) {
    return c.json({ error: "Title is required" }, 400);
  }

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
        { signal: AbortSignal.timeout(8000) },
      );
      if (gbRes.ok) {
        const data = await gbRes.json();
        const items = (data?.items as any[]) || [];
        for (const item of items.slice(0, 5)) {
          const info = item.volumeInfo || {};
          const thumbnail = info.imageLinks?.thumbnail?.replace(
            "http://",
            "https://",
          ) || undefined;
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
                "Authorization": `Bearer ${zaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "glm-4-flash",
                messages: [{
                  role: "user",
                  content:
                    `Provide accurate metadata for the audiobook "${title}" by "${
                      author || "Unknown"
                    }". Return ONLY a JSON object: {"title": "...", "author": "...", "description": "...", "genres": ["..."], "publishedYear": "YYYY"}`,
                }],
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
