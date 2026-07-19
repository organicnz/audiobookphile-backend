import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { Database } from "../../../src/types/supabase.ts";
import { StorageRouter } from "../_shared/storage-router.ts";
import {
  bulkUpsertMediaProgress,
  upsertMediaProgress,
} from "../_shared/progress.ts";

export class PlaybackService {
  static async startSession(
    supabase: SupabaseClient<Database>,
    userId: string,
    libraryItemId: string,
    episodeId?: string | null,
    _deviceInfo?: Record<string, unknown>,
    _supportedMimeTypes?: string[],
    _forceDirectPlay?: boolean,
    _forceTranscode?: boolean,
  ) {
    // Fetch the single library item with all relations
    const { data: item, error: itemError } = await supabase
      .from("library_items")
      .select(`
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

    const audioFilesList =
      ((item as Record<string, unknown>)?.audio_files || []) as Record<
        string,
        unknown
      >[];

    if (!audioFilesList.length) {
      throw new Error("No audio files found for this item");
    }

    const totalBookDuration = Number((item as any).duration) || 0;

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
    const bookAuthors = (item?.book_authors as Record<string, unknown>[]) || [];
    const authors = bookAuthors.map((ba) =>
      ba.authors as Record<string, unknown>
    ).filter(Boolean);
    const authorNames = authors.map((a) => String(a.name));
    const authorName = authorNames.join(", ") || "Unknown Author";

    // Get Chapters
    const chaptersList = (item?.chapters as Record<string, unknown>[]) || [];
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
    const totalDuration = Number((item as any).duration) ||
      currentOffset;
    const sessionUuid = crypto.randomUUID();

    return {
      id: `${libraryItemId}__${sessionUuid}`,
      userId: userId,
      libraryId: item.library_id,
      libraryItemId: libraryItemId,
      episodeId: episodeId || undefined,

      displayTitle: item.title || "Unknown Title",
      displayAuthor: authorName,
      coverPath: item.cover_path || null,

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
    supabase: SupabaseClient<Database>,
    userId: string,
    sessionId: string,
    currentTime: number,
    _timeListened: number,
    duration?: number,
    progress?: number,
    episodeId?: string,
  ) {
    const [libraryItemId, _sessionUuid] = sessionId.split("__");
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

    return { success: true };
  }

  static async bulkSyncSessions(
    supabase: SupabaseClient<Database>,
    userId: string,
    syncPayloads: Array<{
      sessionId: string;
      currentTime: number;
      timeListened: number;
      duration?: number;
      progress?: number;
      episodeId?: string;
    }>,
  ) {
    if (syncPayloads.length === 0) {
      return { success: true, syncedSessionIds: [] };
    }

    const syncedSessionIds: string[] = [];

    // 1. Process media progress
    // We group by libraryItemId + episodeId to find the latest progress update for each item in the batch
    const progressMap = new Map<string, typeof syncPayloads[0]>();
    for (const payload of syncPayloads) {
      const key = `${payload.sessionId}_${payload.episodeId || ""}`;
      const existing = progressMap.get(key);
      if (!existing || existing.currentTime < payload.currentTime) {
        progressMap.set(key, payload);
      }
    }

    const progressItemsToSync = Array.from(progressMap.values());
    const progressItems = progressItemsToSync.map((payload) => {
      const [libraryItemId] = payload.sessionId.split("__");
      return {
        libraryItemId,
        episodeId: payload.episodeId || null,
        currentTime: payload.currentTime,
        duration: payload.duration,
        progress: payload.progress,
        sessionId: payload.sessionId,
      };
    }).filter((item) => item.libraryItemId);

    if (progressItems.length > 0) {
      try {
        await bulkUpsertMediaProgress(supabase, userId, progressItems);
        // All of these sessionIds succeeded
        for (const item of progressItems) {
          syncedSessionIds.push(item.sessionId);
        }
      } catch (e: any) {
        console.warn(
          `[PlaybackService] Bulk progress upsert failed, falling back to individual:`,
          e,
        );
        // Fall back to individual upsert
        for (const item of progressItems) {
          try {
            await upsertMediaProgress(
              supabase,
              userId,
              item.libraryItemId,
              item.episodeId,
              {
                currentTime: item.currentTime,
                duration: item.duration,
                progress: item.progress,
              },
            );
            syncedSessionIds.push(item.sessionId);
          } catch (individualErr: any) {
            console.error(
              `[PlaybackService] Individual progress upsert failed for ${item.sessionId}:`,
              individualErr,
            );
          }
        }
      }
    }

    // 2. Process playback sessions updates
    const sessionUpdates = new Map<
      string,
      { currentTime: number; timeListened: number; originalSessionId: string }
    >();

    for (const payload of syncPayloads) {
      if (!syncedSessionIds.includes(payload.sessionId)) continue;

      const [, sessionUuid] = payload.sessionId.split("__");
      if (sessionUuid) {
        const existing = sessionUpdates.get(sessionUuid) || {
          currentTime: 0,
          timeListened: 0,
          originalSessionId: payload.sessionId,
        };
        sessionUpdates.set(sessionUuid, {
          currentTime: Math.max(existing.currentTime, payload.currentTime),
          timeListened: existing.timeListened + (payload.timeListened || 0),
          originalSessionId: payload.sessionId,
        });
      }
    }

    const sessionUuids = Array.from(sessionUpdates.keys());
    if (sessionUuids.length > 0) {
      try {
        const { data: existingSessions } = await supabase
          .from("playback_sessions")
          .select("id, time_listening")
          .in("id", sessionUuids);

        const existingMap = new Map(
          (existingSessions || []).map((s) => [s.id, s.time_listening || 0]),
        );

        // Update concurrently
        const updatePromises = Array.from(sessionUpdates.entries()).map(
          async ([sessionUuid, update]) => {
            const existingTime = existingMap.get(sessionUuid) || 0;
            try {
              await supabase.from("playback_sessions")
                .update({
                  current_time_pos: update.currentTime,
                  time_listening: existingTime + update.timeListened,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", sessionUuid);
            } catch (sessionErr: any) {
              console.error(
                `[PlaybackService] Failed to update playback_session ${sessionUuid}:`,
                sessionErr,
              );
              // If updating playback_sessions fails, remove it from syncedSessionIds so the client retries
              const idx = syncedSessionIds.indexOf(update.originalSessionId);
              if (idx !== -1) syncedSessionIds.splice(idx, 1);
            }
          },
        );

        await Promise.all(updatePromises);
      } catch (e: any) {
        console.error(
          `[PlaybackService] Failed to fetch or bulk update playback_sessions:`,
          e,
        );
        return {
          success: false,
          error: e.message || "Failed to update playback sessions",
          syncedSessionIds: [],
        };
      }
    }

    return { success: true, syncedSessionIds };
  }

  static async closeSession(
    supabase: SupabaseClient<Database>,
    userId: string,
    sessionId: string,
    currentTime?: number,
    _timeListened?: number,
    duration?: number,
    progress?: number,
    episodeId?: string,
  ) {
    const [libraryItemId, _sessionUuid] = sessionId.split("__");
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

    return { success: true };
  }
}
