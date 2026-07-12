import { createClient } from "@supabase/supabase-js";
import * as mm from "music-metadata";
import { corsHeaders } from "../_shared/cors.ts";
import { StorageRouter } from "../_shared/storage-router.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const db = createClient(supabaseUrl, serviceRoleKey);
    const storageRouter = new StorageRouter(db);

    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const { data: { user }, error: userError } = await createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    ).auth.getUser(authHeader.replace("Bearer ", ""));
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const { data: profile } = await db.from("profiles").select("user_type").eq(
      "id",
      user.id,
    ).single();
    if (!profile || !["admin", "root"].includes(profile.user_type ?? "")) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const url = new URL(req.url);
    const bookId = url.searchParams.get("bookId");

    let query = db.from("books").select("*");
    if (bookId) query = query.eq("id", bookId);

    const { data: books, error } = await query;
    if (error) throw error;

    const results = [];

    for (const book of books || []) {
      if (!book.audio_files) continue;

      const files = book.audio_files;
      const metadataPromises = files.map(async (file: any, _i: number) => {
        let duration = file.duration || file.metadata?.duration || 0;
        // ALWAYS re-sync if 0
        if (duration > 0) {
          return file;
        }

        try {
          const path = file.metadata?.path || file.path || file.storagePath;
          if (path) {
            console.log(`Fetching signed URL for ${path}`);
            const signedUrl = await storageRouter.getSignedUrl(path, 60);
            if (signedUrl) {
              const res = await fetch(signedUrl);
              if (res.body) {
                const metadata = await mm.parseWebStream(
                  res.body,
                  {
                    mimeType: file.mimeType,
                    size: file.size || file.metadata?.size,
                  },
                  { duration: true, skipCovers: true, skipPostHeaders: true },
                );
                duration = metadata.format.duration || 0;
                console.log(`Parsed duration for ${path}: ${duration}`);

                try {
                  res.body.cancel();
                } catch (_e) { /* ignore */ }
              }
            }
          }
        } catch (err: any) {
          console.warn(
            `[sync-durations] Failed for ${file.metadata?.filename}:`,
            err.message,
          );
        }

        return {
          ...file,
          duration,
          metadata: {
            ...(file.metadata || {}),
            duration,
          },
        };
      });

      const updatedAudioFilesJson = await Promise.all(metadataPromises);
      const totalDuration = updatedAudioFilesJson.reduce(
        (sum: number, af: any) => sum + (af.duration || 0),
        0,
      );

      await db.from("books").update({
        audio_files: updatedAudioFilesJson,
        duration: totalDuration,
      }).eq("id", book.id);
      await db.from("books").update({
        audio_files: updatedAudioFilesJson,
        duration: totalDuration,
      }).eq("id", book.id);

      results.push({
        bookTitle: book.title,
        totalDuration,
        tracks: updatedAudioFilesJson.length,
      });
    }

    return new Response(JSON.stringify({ success: true, updated: results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
