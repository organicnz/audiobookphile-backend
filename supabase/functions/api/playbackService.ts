import { SupabaseClient } from "@supabase/supabase-js";
import { StorageRouter } from "../_shared/storage-router.ts";
import { bulkUpsertMediaProgress, upsertMediaProgress } from "../_shared/progress.ts";

export class PlaybackService {
  static async startSession(
    supabase: SupabaseClient,
    userId: string,
    libraryItemId: string,
    episodeId?: string | null,
    deviceInfo?: Record<string, unknown>,
    supportedMimeTypes?: string[],
    forceDirectPlay?: boolean,
    forceTranscode?: boolean,
  ) {
    // Fetch the single library item with all relations
    const { data: item, error: itemError } = await supabase
      .from("library_items")
      .select(`
        *,
        books (
          *,
          book_authors (
            authors (
              *
            )
          ),
          book_series (
            series (
              *
            )
          )
        )
      `)
      .eq("id", libraryItemId)
      .maybeSingle();

    if (itemError || !item) {
      throw new Error(
        `Library item not found: ${
          itemError?.message || "Item does not exist"
        }`,
      );
    }

    const book = Array.isArray(item.books)
      ? (item.books as Record<string, unknown>[])[0]
      : item.books as Record<string, unknown>;
    const audioFilesList = (book?.audio_files ||
      (item.books as Record<string, unknown>)?.audio_files || []) as Record<
        string,
        unknown
      >[];

    if (!audioFilesList.length) {
      throw new Error("No audio files found for this item");
    }

    const totalBookDuration = Number(book?.duration || item.duration) || 0;

    let totalFilesSize = 0;
    const sortedAudioFiles = [...audioFilesList].map((af) => {
      const metadata = ((af as any).metadata as Record<string, unknown>) || {};
      const size = Number(af.size) || Number(metadata.size) || 0;
      totalFilesSize += size;
      return {
        ...af,
        index: af.track_index !== undefined
          ? Number(af.track_index)
          : (af.index !== undefined ? Number(af.index) : 0),
        duration: Number(af.duration) || Number(metadata.duration) || 0,
        size: size,
        mime_type: String(af.mime_type || af.mimeType || "audio/mpeg"),
        codec: String(af.codec || "mp3"),
      };
    }).sort((a, b) => a.index - b.index);

    const needsDurationEstimation = sortedAudioFiles.some((af) =>
      af.duration === 0
    );

    // Get Storage Provider
    const storage = new StorageRouter(supabase);

    // Sign audio files and calculate offset
    let currentOffset = 0;
    const audioTracks: Record<string, unknown>[] = [];
    const missingTracks: string[] = [];

    for (let i = 0; i < sortedAudioFiles.length; i++) {
      const af = sortedAudioFiles[i];
      const metadata = ((af as any).metadata as Record<string, unknown>) || {};
      const storagePath = String(
        metadata.path ?? (af as any).storage_path ?? (af as any).path ?? "",
      );

      let duration = af.duration;
      if (needsDurationEstimation && duration === 0) {
        if (totalBookDuration > 0 && af.size > 0 && totalFilesSize > 0) {
          duration = (af.size / totalFilesSize) * totalBookDuration;
        } else if (totalBookDuration > 0) {
          duration = totalBookDuration / sortedAudioFiles.length;
        } else {
          // If totalBookDuration is unknown, estimate based on 96 kbps (12,000 bytes/sec)
          duration = af.size / 12000;
        }
      }

      let finalSignedUrl = "";
      let isMissing = false;

      try {
        finalSignedUrl = await storage.getSignedUrl(storagePath, 3600);
      } catch (e: unknown) {
        const signErr = e as Error;
        console.warn(
          `[PlaybackService] Missing storage file at "${storagePath}": ${signErr.message}. Skipping track.`,
        );
        missingTracks.push(storagePath);
        isMissing = true;
      }

      if (!isMissing && finalSignedUrl) {
        audioTracks.push({
          index: af.index ?? i,
          startOffset: currentOffset,
          duration: duration,
          title: String(
            metadata.filename || (af as any).filename || `Track ${i + 1}`,
          ),
          contentUrl: finalSignedUrl,
          mimeType: af.mime_type,
          codec: af.codec,
          isMissing: false,
        });
        currentOffset += duration;
      }
    }

    if (audioTracks.length === 0) {
      throw new Error(
        "All audio files are missing from storage. The book may need to be re-uploaded.",
      );
    }

    // Fetch user media progress
    let progressQuery = supabase
      .from("media_progress")
      .select("*")
      .eq("user_id", userId)
      .eq("library_item_id", libraryItemId);

    if (episodeId) {
      progressQuery = progressQuery.eq("episode_id", episodeId);
    } else {
      progressQuery = progressQuery.is("episode_id", null);
    }

    const { data: progressRecord } = await progressQuery.maybeSingle();
    const currentTime = progressRecord
      ? Number(progressRecord.current_time_pos) || 0
      : 0;

    // Get Authors
    const bookAuthors = (book?.book_authors as Record<string, unknown>[]) || [];
    const authors = bookAuthors.map((ba) =>
      ba.authors as Record<string, unknown>
    ).filter(Boolean);
    const authorNames = authors.map((a) => String(a.name));
    const authorName = authorNames.join(", ") || "Unknown Author";

    // Get Chapters
    const chaptersList = (book?.chapters as Record<string, unknown>[]) || [];
    const chapters = chaptersList.map((ch, index) => ({
      id: ch.chapter_index !== undefined
        ? Number(ch.chapter_index)
        : (typeof ch.id === "number" ? ch.id : index),
      title: String(ch.title || ""),
      start: Number(ch.start_time !== undefined ? ch.start_time : ch.start) ||
        0,
      end: Number(ch.end_time !== undefined ? ch.end_time : ch.end) || 0,
    })).sort((a, b) => Number(a.id) - Number(b.id));

    const nowMs = Date.now();
    const totalDuration = Number(book?.duration || item.duration) ||
      currentOffset;
    const sessionUuid = crypto.randomUUID();

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
      user_id: userId,
      library_id: item.library_id,
      media_item_id: libraryItemId,
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

    return {
      id: `${libraryItemId}__${sessionUuid}`,
      userId: userId,
      libraryId: item.library_id,
      libraryItemId: libraryItemId,
      episodeId: episodeId || undefined,

      displayTitle: book?.title || item.title || "Unknown Title",
      displayAuthor: authorName,
      coverPath: item.cover_path || book?.cover_path || null,

      duration: totalDuration,
      playMethod: 0,
      mediaPlayer: "SKIP-ExoPlayer",
      mediaType: item.media_type || "book",

      audioTracks: audioTracks,
      chapters: chapters,

      currentTime: currentTime,
      playbackRate: 1.0,
      startedAt: nowMs,
      updatedAt: nowMs,
    };
  }

  static async syncSession(
    supabase: SupabaseClient,
    userId: string,
    sessionId: string,
    currentTime: number,
    timeListened: number,
    duration?: number,
    progress?: number,
    episodeId?: string,
  ) {
    const [libraryItemId, sessionUuid] = sessionId.split("__");
    if (!libraryItemId) return { success: false, error: "Invalid session ID" };

    try {
      await upsertMediaProgress(
        supabase,
        userId,
        libraryItemId,
        episodeId || null,
        {
          currentTime,
          duration,
          progress,
        },
      );
    } catch (e: any) {
      console.error(`[PlaybackService] Failed to sync session:`, e);
      return {
        success: false,
        error: e.message || "Failed to upsert media progress",
      };
    }

    if (sessionUuid) {
      const { data: session } = await supabase.from("playback_sessions").select(
        "time_listening",
      ).eq("id", sessionUuid).single();
      const existingTime = session?.time_listening || 0;

      await supabase.from("playback_sessions")
        .update({
          current_time_pos: currentTime,
          time_listening: existingTime + (timeListened || 0),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionUuid);
    }

    return { success: true };
  }

  static async bulkSyncSessions(
    supabase: SupabaseClient,
    userId: string,
    syncPayloads: Array<{
      sessionId: string;
      currentTime: number;
      timeListened: number;
      duration?: number;
      progress?: number;
      episodeId?: string;
    }>
  ) {
    if (syncPayloads.length === 0) return { success: true };

    const progressItems = syncPayloads.map(payload => {
      const [libraryItemId] = payload.sessionId.split("__");
      return {
        libraryItemId,
        episodeId: payload.episodeId || null,
        currentTime: payload.currentTime,
        duration: payload.duration,
        progress: payload.progress,
      };
    }).filter(item => item.libraryItemId);

    if (progressItems.length > 0) {
      try {
        await bulkUpsertMediaProgress(supabase, userId, progressItems);
      } catch (e: any) {
        console.error(`[PlaybackService] Failed to bulk upsert media progress:`, e);
        return { success: false, error: e.message || "Failed to bulk upsert media progress" };
      }
    }

    // Now update playback_sessions
    // We aggregate timeListened by sessionUuid
    const sessionUpdates = new Map<string, { currentTime: number; timeListened: number }>();
    
    for (const payload of syncPayloads) {
      const [, sessionUuid] = payload.sessionId.split("__");
      if (sessionUuid) {
        const existing = sessionUpdates.get(sessionUuid) || { currentTime: 0, timeListened: 0 };
        sessionUpdates.set(sessionUuid, {
          currentTime: Math.max(existing.currentTime, payload.currentTime), // Assuming latest currentTime is max
          timeListened: existing.timeListened + (payload.timeListened || 0)
        });
      }
    }

    const sessionUuids = Array.from(sessionUpdates.keys());
    if (sessionUuids.length > 0) {
      try {
        // Fetch existing sessions
        const { data: existingSessions } = await supabase
          .from("playback_sessions")
          .select("id, time_listening")
          .in("id", sessionUuids);

        const existingMap = new Map((existingSessions || []).map(s => [s.id, s.time_listening || 0]));

        // Update concurrently
        const updatePromises = Array.from(sessionUpdates.entries()).map(([sessionUuid, update]) => {
          const existingTime = existingMap.get(sessionUuid) || 0;
          return supabase.from("playback_sessions")
            .update({
              current_time_pos: update.currentTime,
              time_listening: existingTime + update.timeListened,
              updated_at: new Date().toISOString(),
            })
            .eq("id", sessionUuid);
        });
        
        await Promise.all(updatePromises);
      } catch (e: any) {
        console.error(`[PlaybackService] Failed to bulk update playback_sessions:`, e);
      }
    }

    return { success: true };
  }

  static async closeSession(
    supabase: SupabaseClient,
    userId: string,
    sessionId: string,
    currentTime?: number,
    timeListened?: number,
    duration?: number,
    progress?: number,
    episodeId?: string,
  ) {
    const [libraryItemId, sessionUuid] = sessionId.split("__");
    if (!libraryItemId) return { success: false, error: "Invalid session ID" };

    if (currentTime !== undefined) {
      try {
        await upsertMediaProgress(
          supabase,
          userId,
          libraryItemId,
          episodeId || null,
          {
            currentTime,
            duration,
            progress,
          },
        );
      } catch (e: any) {
        console.error(`[PlaybackService] Failed to close session:`, e);
        return {
          success: false,
          error: e.message || "Failed to close session and update progress",
        };
      }
    }

    if (sessionUuid && timeListened !== undefined) {
      const { data: session } = await supabase.from("playback_sessions").select(
        "time_listening",
      ).eq("id", sessionUuid).single();
      const existingTime = session?.time_listening || 0;

      await supabase.from("playback_sessions")
        .update({
          current_time_pos: currentTime ?? 0,
          time_listening: existingTime + (timeListened || 0),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionUuid);
    }

    return { success: true };
  }
}
