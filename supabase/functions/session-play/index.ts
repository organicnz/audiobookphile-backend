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

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/");
    let itemId = pathParts[pathParts.length - 1];

    if (!itemId || itemId === "session-play") {
      try {
        const body = await req.json();
        if (body.itemId) itemId = body.itemId;
      } catch (_e) {
        // ignore
      }
    }

    if (!itemId || itemId === "session-play") {
      return new Response(JSON.stringify({ error: "Missing itemId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the single library item with all relations
    const { data: item, error: itemError } = await supabase
      .from("library_items")
      .select(`
        *,
        books (
          *,
          book_authors (
            authors (*)
          ),
          book_series (
            series (*)
          )
        )
      `)
      .eq("id", itemId)
      .maybeSingle();

    if (itemError || !item) {
      return new Response(JSON.stringify({ error: "Library item not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const book = Array.isArray(item.books)
      ? (item.books as any[])[0]
      : item.books as any;
    const audioFilesList: any[] = book?.audio_files ||
      item.books?.audio_files || [];

    if (!audioFilesList.length) {
      return new Response(
        JSON.stringify({ error: "No audio files found for this item" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Sort audio files by index
    const sortedAudioFiles = [...audioFilesList].map((af: any) => ({
      ...af,
      index: af.track_index !== undefined
        ? af.track_index
        : (af.index !== undefined ? af.index : 0),
      duration: Number(af.duration) || 0,
      size: Number(af.size) || 0,
      mime_type: af.mime_type || af.mimeType || "audio/mpeg",
      codec: af.codec || "mp3",
    })).sort((a: any, b: any) => a.index - b.index);

    // Get Storage Router
    const storageRouter = new StorageRouter(supabase);

    // Sign audio files in parallel to prevent N+1 timeout
    const signPromises = sortedAudioFiles.map(async (af: any, i: number) => {
      const storagePath = af.metadata?.path ?? af.storage_path ?? af.path ?? "";
      try {
        const finalSignedUrl = await storageRouter.getSignedUrl(
          storagePath,
          3600,
        );
        return { af, i, finalSignedUrl, isMissing: false };
      } catch (signErr: any) {
        console.warn(
          `[session-play] Missing storage file at "${storagePath}": ${signErr.message}`,
        );
        return { af, i, finalSignedUrl: "", isMissing: true };
      }
    });

    const signedResults = await Promise.all(signPromises);

    let currentOffset = 0;
    const audioTracks: any[] = [];

    for (const res of signedResults) {
      const { af, i, finalSignedUrl, isMissing } = res;
      const duration = af.duration;

      if (!isMissing && finalSignedUrl) {
        audioTracks.push({
          index: af.index ?? i,
          startOffset: currentOffset,
          duration: duration,
          title: af.metadata?.filename || af.filename || `Track ${i + 1}`,
          contentUrl: finalSignedUrl,
          mimeType: af.mime_type,
          codec: af.codec,
          isMissing: false,

          // Legacy properties required by some clients
          start_offset: currentOffset,
          content_url: finalSignedUrl,
          mime_type: af.mime_type,
          is_missing: false,
        });
        currentOffset += duration;
      }
    }

    if (audioTracks.length === 0) {
      return new Response(
        JSON.stringify({ error: "All audio files are missing from storage" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Fetch user media progress
    const { data: progressRecord } = await supabase
      .from("media_progress")
      .select("*")
      .eq("user_id", user.id)
      .eq("library_item_id", itemId)
      .is("episode_id", null)
      .maybeSingle();

    const currentTime = progressRecord
      ? Number(progressRecord.current_time_pos) || 0
      : 0;

    // Get Authors
    const authors = book?.book_authors?.map((ba: any) =>
      ba.authors
    ).filter(Boolean) || [];
    const authorNames = authors.map((a: any) => a.name);
    const authorName = authorNames.join(", ") || "Unknown Author";

    // Get Chapters
    const chaptersList = book?.chapters || [];
    const chapters = chaptersList.map((ch: any, index: number) => ({
      id: ch.chapter_index !== undefined
        ? ch.chapter_index
        : (typeof ch.id === "number" ? ch.id : index),
      title: ch.title,
      start: Number(ch.start_time !== undefined ? ch.start_time : ch.start) ||
        0,
      end: Number(ch.end_time !== undefined ? ch.end_time : ch.end) || 0,
    })).sort((a: any, b: any) => a.id - b.id);

    const nowMs = Date.now();
    const totalDuration = Number(book?.duration || item.duration) ||
      currentOffset;

    // Generate session ID
    const sessionUuid = crypto.randomUUID();
    const sessionId = `${itemId}__${sessionUuid}`;

    const sessionDate = new Date();
    const dayOfWeek = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][sessionDate.getDay()];
    const sessionDateStr = sessionDate.toISOString().split("T")[0];

    // Save robust session log into db
    await supabase.from("playback_sessions").insert({
      id: sessionUuid,
      user_id: user.id,
      library_id: item.library_id,
      media_item_id: itemId,
      media_item_type: item.media_type || "book",
      display_title: book?.title || item.title || "Unknown Title",
      display_author: authorName,
      duration: totalDuration,
      play_method: 0,
      media_player: "html5",
      start_time_pos: currentTime,
      current_time_pos: currentTime,
      time_listening: 0,
      session_date: sessionDateStr,
      day_of_week: dayOfWeek,
      server_version: "Edge",
      cover_path: item.cover_path || book?.cover_path || null,
    });

    const playbackSession = {
      id: sessionId,
      userId: user.id,
      libraryId: item.library_id,
      libraryItemId: itemId,

      displayTitle: book?.title || item.title || "Unknown Title",
      displayAuthor: authorName,
      coverPath: item.cover_path || book?.cover_path || null,
      cover_path: item.cover_path || book?.cover_path || null,

      duration: totalDuration,
      playMethod: 0,
      play_method: 0,
      mediaPlayer: "SKIP-ExoPlayer",
      media_player: "SKIP-ExoPlayer",
      mediaType: item.media_type || "book",
      media_type: item.media_type || "book",

      audioTracks: audioTracks,
      audio_tracks: audioTracks,
      chapters: chapters,

      currentTime: currentTime,
      current_time: currentTime,
      playbackRate: 1.0,
      playback_rate: 1.0,
      startedAt: nowMs,
      started_at: nowMs,
      updatedAt: nowMs,
      updated_at: nowMs,
    };

    return new Response(JSON.stringify(playbackSession), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error(`[session-play] Fatal Error:`, err.message);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
