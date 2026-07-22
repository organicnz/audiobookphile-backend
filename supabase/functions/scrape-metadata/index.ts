import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { corsHeaders } from "../_shared/cors.ts";

// Note: Ensure `EdgeRuntime` is configured in the environment to allow async operations after response
declare const EdgeRuntime: any;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Auth client with service role key to bypass RLS
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { data: profile } = await supabase.from("profiles").select(
      "user_type",
    ).eq("id", user.id).single();
    if (!profile || !["admin", "root"].includes(profile.user_type ?? "")) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const body = await req.json().catch(() => ({}));
    const { libraryItemId } = body;

    if (!libraryItemId) {
      return new Response(
        JSON.stringify({ error: "libraryItemId is required" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Fetch the item
    const { data: item, error: fetchErr } = await supabase
      .from("library_items")
      .select("media_id, media_type, author_names_first_last, title")
      .eq("id", libraryItemId)
      .single();

    if (fetchErr || !item) {
      return new Response(JSON.stringify({ error: "Library item not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (item.media_type !== "book" || !item.media_id) {
      return new Response(
        JSON.stringify({
          error: "Only books are supported for metadata scraping",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const { data: book, error: bookErr } = await supabase
      .from("library_items")
      .select("title, description, genres, published_year")
      .eq("id", item.media_id)
      .single();

    if (bookErr || !book) {
      return new Response(JSON.stringify({ error: "Book record not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const title = book.title || item.title;
    const authorName = item.author_names_first_last;

    if (!title) {
      return new Response(
        JSON.stringify({ error: "Item has no title to search" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Process scraping asynchronously to prevent timeout
    const scrapeAndPatch = async () => {
      console.log(`Starting metadata scrape for: ${title} by ${authorName}`);
      try {
        let query = `intitle:${encodeURIComponent(title)}`;
        if (authorName) {
          query += `+inauthor:${encodeURIComponent(authorName)}`;
        }

        const res = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`,
        );
        if (!res.ok) {
          throw new Error("Failed to fetch from Google Books API");
        }

        const data = await res.json();
        if (data.items && data.items.length > 0) {
          const volumeInfo = data.items[0].volumeInfo;

          let updateNeeded = false;
          const updates: any = {};

          if (!book.description && volumeInfo.description) {
            updates.description = volumeInfo.description;
            updateNeeded = true;
          }

          if (
            (!book.genres ||
              (Array.isArray(book.genres) && book.genres.length === 0)) &&
            volumeInfo.categories
          ) {
            updates.genres = volumeInfo.categories;
            updateNeeded = true;
          }

          if (!book.published_year && volumeInfo.publishedDate) {
            updates.published_year = volumeInfo.publishedDate.substring(0, 4);
            updateNeeded = true;
          }

          if (updateNeeded) {
            console.log(
              `Found missing metadata, patching books id: ${item.media_id}`,
            );
            const { error: updateErr } = await supabase
              .from("library_items")
              .update(updates)
              .eq("id", item.media_id);

            if (updateErr) {
              console.error("Failed to update books:", updateErr);
            }
          } else {
            console.log("No missing metadata found or needed updating.");
          }
        } else {
          console.log("No matches found on Google Books.");
        }

        // Z.ai GLM-4 AI metadata enrichment fallback if description or genres are still missing
        const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
          Deno.env.get("ZHIPU_API_KEY") ?? "";
        if (
          (!book.description ||
            (!book.genres || book.genres.length === 0)) && zaiApiKey
        ) {
          console.log(`Enriching metadata with Z.ai GLM-4 for: ${title}`);
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
                      authorName ||
                      "Unknown"
                    }". Return ONLY a valid JSON object with keys: {"description": "concise synopsis (max 3 sentences)", "genres": ["Genre1", "Genre2"], "publishedYear": "YYYY"}.`,
                }],
                temperature: 0.2,
              }),
            },
          );
          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const content = aiData.choices?.[0]?.message?.content || "";
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              const aiUpdates: any = {};
              if (!book.description && parsed.description) {
                aiUpdates.description = parsed.description;
              }
              if (
                (!book.genres || book.genres.length === 0) && parsed.genres
              ) {
                aiUpdates.genres = parsed.genres;
              }
              if (!book.published_year && parsed.publishedYear) {
                aiUpdates.published_year = String(parsed.publishedYear)
                  .substring(0, 4);
              }

              if (Object.keys(aiUpdates).length > 0) {
                await supabase.from("library_items").update(aiUpdates).eq(
                  "id",
                  item.media_id,
                );
              }
            }
          }
        }
      } catch (e) {
        console.error("Scraping error:", e);
      }
    };

    // WaitUntil lets the execution continue after returning a response
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(scrapeAndPatch());
    } else {
      // Fallback for local testing if not using actual EdgeRuntime
      scrapeAndPatch();
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Scraping started asynchronously",
      }),
      {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: unknown) {
    const err = e as Error;
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
