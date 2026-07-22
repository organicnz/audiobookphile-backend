import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchAuthorAvatar } from "../_shared/avatarFetcher.ts";

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
  const envCronSecret = Deno.env.get("CRON_SECRET");

  if (envCronSecret && authHeader === `Bearer ${envCronSecret}`) {
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
      const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
      const limit = Math.min(Math.max(limitParam, 1), 20);

      // Select authors missing images
      const { data: authors, error: authorsError } = await adminClient
        .from("authors")
        .select("id, name")
        .is("image_path", null)
        .limit(limit);

      if (authorsError) throw authorsError;

      const { count } = await adminClient
        .from("authors")
        .select("*", { count: "exact", head: true })
        .is("image_path", null);

      const matchUnlinkedAuthorsAsync = async () => {
        const { data: items } = await adminClient
          .from("library_items")
          .select(
            "id, library_id, author_names_first_last, book_authors(author_id)",
          )
          .not("author_names_first_last", "is", null);

        if (!items) return;
        const unlinkedItems = items.filter(
          (item: any) => !item.book_authors || item.book_authors.length === 0,
        );

        for (const item of unlinkedItems) {
          const rawAuthorStr = item.author_names_first_last?.trim();
          if (!rawAuthorStr || !item.library_id) continue;

          const rawAuthors = rawAuthorStr.split(/\s*(?:\/|,|&|\band\b)\s*/i)
            .map((a: string) => a.trim()).filter(Boolean);
          const cleanAuthors = rawAuthors.map((a: string) => {
            let name = a;
            const dashSplit = name.split(" - ");
            if (dashSplit.length > 1) name = dashSplit[0];
            name = name.replace(/\b(Ph\.?D\.?|M\.?D\.?)\b/gi, "");
            name = name.replace(/([A-Za-z])\./g, "$1");
            return name.replace(/\s+/g, " ").trim();
          }).filter(Boolean);

          const uniqueAuthors = Array.from(new Set(cleanAuthors));

          for (const singleAuthor of uniqueAuthors) {
            await adminClient.from("authors").upsert({
              id: crypto.randomUUID(),
              name: singleAuthor,
              library_id: item.library_id,
            }, { onConflict: "library_id, name", ignoreDuplicates: true });

            const { data: existingAuthor } = await adminClient
              .from("authors")
              .select("id")
              .eq("name", singleAuthor)
              .eq("library_id", item.library_id)
              .maybeSingle();

            if (existingAuthor?.id) {
              await adminClient.from("book_authors").upsert({
                library_item_id: item.id,
                author_id: existingAuthor.id,
              }, {
                onConflict: "library_item_id, author_id",
                ignoreDuplicates: true,
              });
            }
          }
        }
      };

      const processAuthorsAsync = async () => {
        try {
          await matchUnlinkedAuthorsAsync();
        } catch (e: any) {
          console.error(
            "[Sync Authors] Unlinked author matching error:",
            e.message,
          );
        }

        let successCount = 0;
        let errorCount = 0;
        let notFoundCount = 0;

        for (const author of authors) {
          if (!author.name) continue;

          console.log(
            `[Sync Authors] Fetching avatar for: "${author.name}"...`,
          );
          try {
            await sleep(1500); // Rate limit protection
            const storagePath = await fetchAuthorAvatar(adminClient, author);

            if (storagePath) {
              await adminClient.from("authors").update({
                image_path: storagePath,
              }).eq("id", author.id);
              successCount++;
            } else {
              // If we thoroughly checked and no photo was found (even DiceBear failed), mark as missing
              await adminClient.from("authors").update({
                image_path: "missing",
              }).eq("id", author.id);
              notFoundCount++;
              console.log(
                `[Sync Authors] No avatar found for "${author.name}" - marked as missing.`,
              );
            }
          } catch (e: any) {
            console.error(
              `[Sync Authors] Error processing ${author.name}:`,
              e.message,
            );
            errorCount++;
          }
        }
        console.log(
          `[Sync Authors] Background task complete. Success: ${successCount}, Not Found: ${notFoundCount}, Errors: ${errorCount}`,
        );
      };

      // Offload actual fetching to background
      // @ts-ignore - EdgeRuntime is injected by Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(processAuthorsAsync());
      } else {
        await processAuthorsAsync();
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: `Started background sync for ${authors.length} authors`,
          remaining: (count || 0) - authors.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const err = e as Error;
    console.error("[Sync Authors] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
