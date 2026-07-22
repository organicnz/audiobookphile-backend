import { createClient } from "npm:@supabase/supabase-js@2";
import { StorageRouter } from "../_shared/storage-router.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: authHeader ? { Authorization: authHeader } : {} },
    });

    const { data: { user } } = authHeader
      ? await supabase.auth.getUser()
      : { data: { user: null } };
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { itemId, episodeId } = await req.json();

    const { data: item, error: itemError } = await supabase
      .from("library_items")
      .select("*, books(audio_files, chapters)")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      return new Response(JSON.stringify({ error: "Library item not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const book = Array.isArray(item.books) ? item.books[0] : item.books as any;
    let audioFiles = (book?.audio_files as any[]) || [];

    if (episodeId) {
      audioFiles = audioFiles.filter((f: any) => f.episodeId === episodeId);
    }

    if (!audioFiles || audioFiles.length === 0) {
      return new Response(JSON.stringify({ error: "No audio files found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const storageRouter = new StorageRouter(supabase);
    const tracksWithUrls = (await Promise.all(
      audioFiles.map(async (audioFile, idx) => {
        const storagePath = audioFile.metadata?.path ??
          audioFile.storage_path ?? "";
        try {
          const finalSignedUrl = await storageRouter.getSignedUrl(
            storagePath,
            3600,
          );
          return {
            index: audioFile.index ?? idx,
            audioFileId: audioFile.ino || audioFile.id,
            contentUrl: finalSignedUrl,
            duration: audioFile.duration,
            mimeType: audioFile.mimeType || audioFile.mime_type,
          };
        } catch (signErr: any) {
          console.warn(
            `[playback-start] Missing storage file at "${storagePath}": ${signErr.message}`,
          );
          return null;
        }
      }),
    )).filter(Boolean);

    const chapters = (book?.chapters as any[]) || [];

    let progressQuery = supabase
      .from("media_progress")
      .select("current_time_pos")
      .eq("user_id", user.id)
      .eq("library_item_id", itemId);

    if (episodeId) {
      progressQuery = progressQuery.eq("episode_id", episodeId);
    } else {
      progressQuery = progressQuery.is("episode_id", null);
    }

    const { data: progressData } = await progressQuery.maybeSingle();
    const currentTime = progressData?.current_time_pos ?? 0;
    const totalDuration = audioFiles.reduce(
      (sum: number, f: any) => sum + (f.duration ?? 0),
      0,
    );

    return new Response(
      JSON.stringify({
        tracks: tracksWithUrls,
        chapters,
        currentTime,
        duration: totalDuration,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
