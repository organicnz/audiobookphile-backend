import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchBookMetadata } from "../_shared/coverFetch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Auth: check for cron secret OR admin user
  const authHeader = req.headers.get("Authorization");
  let isAdmin = false;
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (
    typeof cronSecret === "string" && cronSecret.length > 0 &&
    authHeader === `Bearer ${cronSecret}`
  ) {
    isAdmin = true;
  } else if (authHeader) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    ).auth.getUser(token);
    if (user) {
      const { data: profile } = await adminClient.from("profiles").select(
        "user_type",
      ).eq("id", user.id).single();
      if (profile?.user_type === "admin" || profile?.user_type === "root") {
        isAdmin = true;
      }
    }
  }

  if (!isAdmin) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (req.method === "POST") {
      const url = new URL(req.url);
      const limitParam = parseInt(url.searchParams.get("limit") || "5", 10);
      const limit = Math.min(Math.max(limitParam, 1), 20); // bump limit since it's backgrounded

      const { data: items, error: itemsError } = await adminClient
        .from("library_items")
        .select("id, cover_path, books(cover_path, title, author_names)")
        .or("cover_path.is.null,cover_path.like./%")
        .limit(limit);

      if (itemsError) throw itemsError;

      const { count } = await adminClient
        .from("library_items")
        .select("*", { count: "exact", head: true })
        .or("cover_path.is.null,cover_path.like./%");

      const processCoversAsync = async () => {
        let successCount = 0;
        let errorCount = 0;
        let notFoundCount = 0;

        for (const item of items) {
          let legacyPath = item.cover_path;
          let title = "";
          let author = "";

          if (item.books) {
            const book = Array.isArray(item.books) ? item.books[0] : item.books;
            if (book) {
              if (!legacyPath) legacyPath = book.cover_path;
              title = book.title;
              if (
                book.author_names && Array.isArray(book.author_names) &&
                book.author_names.length > 0
              ) {
                author = book.author_names[0];
              }
            }
          }

          if (legacyPath && !legacyPath.startsWith("/")) continue;

          if (title) {
            console.log(
              `[Sync Covers] Fetching cover for: "${title}" by ${author}...`,
            );
            try {
              await sleep(1500); // Rate limit protection
              const fetchRes = await fetchBookMetadata(title, author);

              if (fetchRes && fetchRes.cover && fetchRes.cover.buffer) {
                const fileData = new Uint8Array(fetchRes.cover.buffer);
                const ext = fetchRes.cover.extension || "jpg";
                const storagePath = `${item.id}/cover.${ext}`;
                const contentType = `image/${ext === "png" ? "png" : "jpeg"}`;

                console.log(
                  `[Sync Covers] Uploading to covers/${storagePath}...`,
                );

                const { error: uploadError } = await adminClient.storage
                  .from("covers")
                  .upload(storagePath, fileData.buffer, {
                    upsert: true,
                    contentType,
                  });

                if (uploadError) throw uploadError;

                await adminClient.from("library_items").update({
                  cover_path: storagePath,
                }).eq("id", item.id);
                successCount++;
              } else {
                console.log(`[Sync Covers] No cover found for "${title}"`);
                notFoundCount++;
              }
            } catch (e: any) {
              console.error(
                `[Sync Covers] Error processing ${title}:`,
                e.message,
              );
              errorCount++;
            }
          }
        }
        console.log(
          `[Sync Covers] Background task complete. Success: ${successCount}, Not Found: ${notFoundCount}, Errors: ${errorCount}`,
        );
      };

      // Offload actual fetching to background
      // @ts-ignore - EdgeRuntime is injected by Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(processCoversAsync());
      } else {
        await processCoversAsync();
      }

      return new Response(
        JSON.stringify({
          message: "Batch sync accepted and running in background",
          processed: items.length,
          remaining: count,
        }),
        {
          status: 202,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  } catch (err: any) {
    console.error(`[Sync Covers] Fatal Error:`, err.message);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
