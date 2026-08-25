import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { Database } from "../../../src/types/supabase.ts";
import { StorageRouter } from "../_shared/storage-router.ts";
import {
  bulkUpsertMediaProgress,
  upsertMediaProgress,
} from "../_shared/progress.ts";
import { getErrorMessage } from "./_shared/errors.ts";

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
      .select(
        `
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
      `,
      )
      .eq("id", libraryItemId)
      .maybeSingle();

    if (itemError || !item) {
      throw new Error(
        `Library item not found: ${
          itemError?.message || "Item does not exist"
        }`,
      );
    }

    let rawAudioFiles = item.audio_files || [];
    if (typeof rawAudioFiles === "string") {
      try {
        rawAudioFiles = JSON.parse(rawAudioFiles);
      } catch {
        rawAudioFiles = [];
      }
    }
    let audioFilesList =
      (Array.isArray(rawAudioFiles) ? rawAudioFiles : []) as Record<
        string,
        unknown
      >[];

    // Fallback: If audio_files is empty, extract audio files from library_files
    if (!audioFilesList.length) {
      let rawLibraryFiles = item.library_files || [];
      if (typeof rawLibraryFiles === "string") {
        try {
          rawLibraryFiles = JSON.parse(rawLibraryFiles);
        } catch {
          rawLibraryFiles = [];
        }
      }
      const libraryFiles =
        (Array.isArray(rawLibraryFiles) ? rawLibraryFiles : []) as Record<
          string,
          unknown
        >[];
      const audioExts = [
        ".mp3",
        ".m4b",
        ".m4a",
        ".aac",
        ".flac",
        ".ogg",
        ".oga",
        ".ogv",
        ".opus",
        ".wav",
        ".webm",
        ".webma",
        ".wma",
        ".aiff",
        ".aif",
        ".caf",
        ".awb",
        ".mka",
        ".mkv",
        ".mp4",
        ".m4v",
      ];
      const extracted = libraryFiles
        .filter((lf) => {
          const metadata = (lf.metadata as Record<string, unknown>) || {};
          const ext = String(metadata.ext || "").toLowerCase();
          const relPath = String(
            metadata.relPath || metadata.filename || lf.path || "",
          ).toLowerCase();
          return audioExts.some((e) => ext.endsWith(e) || relPath.endsWith(e));
        })
        .map((lf, idx) => {
          const metadata = (lf.metadata as Record<string, unknown>) || {};
          const ext = String(metadata.ext || "").toLowerCase().replace(
            /^\./,
            "",
          );
          let mimeType = String(metadata.mimeType || "");
          if (
            !mimeType || mimeType === "audio/mpeg" ||
            mimeType === "application/octet-stream"
          ) {
            switch (ext) {
              case "m4b":
              case "m4a":
              case "mp4":
              case "m4v":
                mimeType = "audio/mp4";
                break;
              case "mp3":
              case "mpeg":
              case "mpg":
                mimeType = "audio/mpeg";
                break;
              case "flac":
                mimeType = "audio/flac";
                break;
              case "opus":
                mimeType = "audio/opus";
                break;
              case "ogg":
              case "oga":
              case "ogv":
                mimeType = "audio/ogg";
                break;
              case "aac":
                mimeType = "audio/aac";
                break;
              case "wav":
                mimeType = "audio/wav";
                break;
              case "webm":
              case "webma":
                mimeType = "audio/webm";
                break;
              case "wma":
              case "wmv":
              case "asf":
                mimeType = "audio/x-ms-wma";
                break;
              case "aiff":
              case "aif":
                mimeType = "audio/aiff";
                break;
              case "caf":
                mimeType = "audio/x-caf";
                break;
              case "awb":
              case "3gp":
                mimeType = "audio/amr-wb";
                break;
              case "mka":
              case "mkv":
                mimeType = "audio/x-matroska";
                break;
              default:
                mimeType = metadata.mimeType
                  ? String(metadata.mimeType)
                  : "audio/mpeg";
            }
          }

          let codec = String(metadata.codec || "");
          if (!codec || codec === "mp3") {
            switch (ext) {
              case "m4b":
              case "m4a":
              case "mp4":
              case "m4v":
              case "aac":
              case "caf":
                codec = "aac";
                break;
              case "flac":
                codec = "flac";
                break;
              case "opus":
                codec = "opus";
                break;
              case "ogg":
              case "oga":
              case "ogv":
                codec = "vorbis";
                break;
              case "wav":
              case "aiff":
              case "aif":
                codec = "pcm";
                break;
              case "wma":
              case "wmv":
              case "asf":
                codec = "wma";
                break;
              case "awb":
              case "3gp":
                codec = "amr-wb";
                break;
              default:
                codec = metadata.codec ? String(metadata.codec) : "mp3";
            }
          }

          return {
            index: idx,
            ino: lf.ino,
            metadata: metadata,
            size: Number(lf.size) || Number(metadata.size) || 0,
            duration: Number(lf.duration) || Number(metadata.duration) || 0,
            mime_type: mimeType,
            codec: codec,
            filename: String(
              metadata.filename || metadata.relPath || `Track ${idx + 1}`,
            ),
            path: String(
              lf.path || metadata.path || metadata.relPath ||
                metadata.filename || "",
            ),
            storage_path: String(
              lf.storage_path || lf.path || metadata.path || metadata.relPath ||
                metadata.filename || "",
            ),
          };
        });

      if (extracted.length > 0) {
        audioFilesList = extracted;
      }
    }

    if (!audioFilesList.length) {
      throw new Error("No audio files found for this item");
    }

    const totalBookDuration = Number((item as any).duration) || 0;

    let totalFilesSize = 0;
    const sortedAudioFiles = [...audioFilesList]
      .map((af, idx) => {
        const metadata = ((af as any).metadata as Record<string, unknown>) ||
          {};
        const ext = String(
          metadata.ext || (af as any).filename?.split(".").pop() || "",
        ).toLowerCase().replace(/^\./, "");
        const size = Number(af.size) || Number(metadata.size) || 0;
        totalFilesSize += size;

        let mimeType = String(
          af.mime_type || af.mimeType || metadata.mimeType || "",
        );
        if (
          !mimeType || mimeType === "audio/mpeg" ||
          mimeType === "application/octet-stream"
        ) {
          switch (ext) {
            case "m4b":
            case "m4a":
            case "mp4":
            case "m4v":
              mimeType = "audio/mp4";
              break;
            case "mp3":
            case "mpeg":
            case "mpg":
              mimeType = "audio/mpeg";
              break;
            case "flac":
              mimeType = "audio/flac";
              break;
            case "opus":
              mimeType = "audio/opus";
              break;
            case "ogg":
            case "oga":
            case "ogv":
              mimeType = "audio/ogg";
              break;
            case "aac":
              mimeType = "audio/aac";
              break;
            case "wav":
              mimeType = "audio/wav";
              break;
            case "webm":
            case "webma":
              mimeType = "audio/webm";
              break;
            case "wma":
            case "wmv":
            case "asf":
              mimeType = "audio/x-ms-wma";
              break;
            case "aiff":
            case "aif":
              mimeType = "audio/aiff";
              break;
            case "caf":
              mimeType = "audio/x-caf";
              break;
            case "awb":
            case "3gp":
              mimeType = "audio/amr-wb";
              break;
            case "mka":
            case "mkv":
              mimeType = "audio/x-matroska";
              break;
            default:
              mimeType = af.mime_type ? String(af.mime_type) : "audio/mpeg";
          }
        }

        let codec = String(af.codec || metadata.codec || "");
        if (!codec || codec === "mp3") {
          switch (ext) {
            case "m4b":
            case "m4a":
            case "mp4":
            case "m4v":
            case "aac":
            case "caf":
              codec = "aac";
              break;
            case "flac":
              codec = "flac";
              break;
            case "opus":
              codec = "opus";
              break;
            case "ogg":
            case "oga":
            case "ogv":
              codec = "vorbis";
              break;
            case "wav":
            case "aiff":
            case "aif":
              codec = "pcm";
              break;
            case "wma":
            case "wmv":
            case "asf":
              codec = "wma";
              break;
            case "awb":
            case "3gp":
              codec = "amr-wb";
              break;
            default:
              codec = af.codec ? String(af.codec) : "mp3";
          }
        }

        return {
          ...af,
          index: af.track_index !== undefined
            ? Number(af.track_index)
            : af.index !== undefined
            ? Number(af.index)
            : idx,
          duration: Number(af.duration) || Number(metadata.duration) || 0,
          size: size,
          mime_type: mimeType,
          codec: codec,
        };
      })
      .sort((a, b) => a.index - b.index);

    const needsDurationEstimation = sortedAudioFiles.some((af) =>
      af.duration === 0
    );

    // Get Storage Provider
    const storage = new StorageRouter(supabase);

    // Sign audio files concurrently
    const signedTrackResults = await Promise.all(
      sortedAudioFiles.map(async (af, i) => {
        const metadata = ((af as any).metadata as Record<string, unknown>) ||
          {};
        const storagePath = String(
          metadata.path ||
            (af as any).storage_path ||
            (af as any).path ||
            (af as any).relPath ||
            (af as any).rel_path ||
            metadata.relPath ||
            metadata.rel_path ||
            metadata.filename ||
            (af as any).filename ||
            "",
        );

        let duration = af.duration;
        if (needsDurationEstimation && duration === 0) {
          if (totalBookDuration > 0 && af.size > 0 && totalFilesSize > 0) {
            duration = (af.size / totalFilesSize) * totalBookDuration;
          } else if (totalBookDuration > 0) {
            duration = totalBookDuration / sortedAudioFiles.length;
          } else {
            duration = af.size / 12000;
          }
        }

        let finalSignedUrl = "";
        let isMissing = false;
        let resolvedCanonicalPath: string | null = null;

        try {
          const isLegacyPath = storagePath.startsWith("/") ||
            (!storagePath.includes("://") && storagePath.length > 0);

          if (isLegacyPath) {
            const resolved = await storage.resolveAndSign(
              storagePath,
              libraryItemId,
              604800,
            );
            finalSignedUrl = resolved.signedUrl;
            resolvedCanonicalPath = resolved.canonicalPath;
          } else {
            finalSignedUrl = await storage.getSignedUrl(storagePath, 604800);
          }
        } catch (e: unknown) {
          const signErr = e as Error;
          console.warn(
            `[PlaybackService] Missing storage file at "${storagePath}": ${signErr.message}. Skipping track.`,
          );
          isMissing = true;
        }

        return {
          af,
          index: af.index ?? i,
          duration,
          finalSignedUrl,
          isMissing,
          storagePath,
          resolvedCanonicalPath,
          metadata,
          filename: String(
            metadata.filename || (af as any).filename || `Track ${i + 1}`,
          ),
        };
      }),
    );

    let currentOffset = 0;
    const audioTracks: Record<string, unknown>[] = [];
    const missingTracks: string[] = [];

    // --- Self-heal: verify the first scheme'd track actually exists ---
    // Presigning is a purely local computation — it never contacts storage —
    // so a stale or mis-recorded path yields URLs that 404 only when the
    // player fetches them (the "black screen" book failure mode: the session
    // succeeds, every track fails, and the client retries silently).
    // Legacy paths were already HEAD-verified inside resolveAndSign; scheme'd
    // paths were not. Probe the first live scheme'd track, and on a miss
    // re-resolve every track across all tiers and candidate prefixes
    // ({itemId}/{filename} plus the recorded path's own prefix — uploads are
    // keyed by a client-generated bookId that can differ from the item id),
    // then patch the DB with wherever the files actually live.
    const firstLive = signedTrackResults.find((r) =>
      !r.isMissing && r.finalSignedUrl
    );
    const firstLiveWasVerified = !!firstLive?.resolvedCanonicalPath;
    if (firstLive && !firstLiveWasVerified) {
      const exists = await storage.fileExists(firstLive.storagePath).catch(
        () => false,
      );
      if (!exists) {
        console.warn(
          `[PlaybackService] Recorded path for first track no longer exists: "${firstLive.storagePath}" — probing alternate tiers/prefixes for ${libraryItemId}`,
        );
        for (const res of signedTrackResults) {
          if (res.isMissing) continue;
          const filename = res.storagePath.split("/").pop()!;
          const recordedPrefix = res.storagePath.includes("://")
            ? res.storagePath.replace(/^[a-z0-9-]+:\/\//i, "").split("/")
              .slice(0, -1).join("/")
            : "";
          const candidates = [`${libraryItemId}/${filename}`];
          if (recordedPrefix && recordedPrefix !== libraryItemId) {
            candidates.push(`${recordedPrefix}/${filename}`);
          }
          const resolved = await storage.signFirstExisting(candidates, 604800);
          if (resolved) {
            console.info(
              `[PlaybackService] Self-healed track "${filename}": ${res.storagePath} → ${resolved.canonicalPath}`,
            );
            res.finalSignedUrl = resolved.signedUrl;
            res.resolvedCanonicalPath = resolved.canonicalPath;
          } else {
            console.warn(
              `[PlaybackService] Track "${filename}" not found in any backend under ${
                candidates.join(", ")
              }`,
            );
            res.isMissing = true;
            res.finalSignedUrl = "";
          }
        }
      }
    }

    for (const res of signedTrackResults) {
      if (res.isMissing) {
        missingTracks.push(res.storagePath);
        continue;
      }

      if (res.resolvedCanonicalPath) {
        (async () => {
          try {
            const { data: currentItem } = await supabase
              .from("library_items")
              .select("audio_files")
              .eq("id", libraryItemId)
              .single();

            if (currentItem?.audio_files) {
              const updatedFiles = (
                currentItem.audio_files as Record<string, unknown>[]
              ).map((af: Record<string, unknown>) => {
                const afMeta = (af.metadata as Record<string, unknown>) || {};
                if (String(afMeta.path ?? "") === res.storagePath) {
                  return {
                    ...af,
                    metadata: {
                      ...afMeta,
                      path: res.resolvedCanonicalPath,
                    },
                  };
                }
                return af;
              });

              await supabase
                .from("library_items")
                .update({ audio_files: updatedFiles as any })
                .eq("id", libraryItemId);
            }
          } catch (patchErr) {
            console.warn(
              `[PlaybackService] Failed to patch legacy path "${res.storagePath}" → "${res.resolvedCanonicalPath}":`,
              patchErr,
            );
          }
        })();
      }

      if (res.finalSignedUrl) {
        audioTracks.push({
          index: res.index,
          startOffset: currentOffset,
          duration: res.duration,
          title: res.filename,
          contentUrl: res.finalSignedUrl,
          mimeType: res.af.mime_type,
          codec: res.af.codec,
          isMissing: false,
        });
        currentOffset += res.duration;
      }
    }

    if (audioTracks.length === 0) {
      throw new Error(
        "All audio files are missing from storage. The book may need to be re-uploaded.",
      );
    }

    // Fetch user media progress
    let progressQuery = supabase.from("media_progress").select("*").eq(
      "user_id",
      userId,
    ).eq("library_item_id", libraryItemId);

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
    const chapters = chaptersList
      .map((ch, index) => ({
        id: ch.chapter_index !== undefined
          ? Number(ch.chapter_index)
          : typeof ch.id === "number"
          ? ch.id
          : index,
        title: String(ch.title || ""),
        start: Number(ch.start_time !== undefined ? ch.start_time : ch.start) ||
          0,
        end: Number(ch.end_time !== undefined ? ch.end_time : ch.end) || 0,
      }))
      .sort((a, b) => Number(a.id) - Number(b.id));

    const nowMs = Date.now();
    const totalDuration = Number((item as any).duration) || currentOffset;
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
      manifestUrl: `/api/items/${libraryItemId}/manifest.m3u8`,

      // Clients surface this so partial books are visible instead of silently
      // skipping content ("why does chapter 4 narrate chapter 9?" class of bug
      // reports). 0 when every track resolved.
      missingTrackCount: missingTracks.length,

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
    } catch (e: unknown) {
      console.error(`[PlaybackService] Failed to sync session:`, e);
      return {
        success: false,
        error: getErrorMessage(e) || "Failed to upsert media progress",
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
    const progressMap = new Map<string, (typeof syncPayloads)[0]>();
    for (const payload of syncPayloads) {
      const key = `${payload.sessionId}_${payload.episodeId || ""}`;
      const existing = progressMap.get(key);
      if (!existing || existing.currentTime < payload.currentTime) {
        progressMap.set(key, payload);
      }
    }

    const progressItemsToSync = Array.from(progressMap.values());
    const progressItems = progressItemsToSync
      .map((payload) => {
        const [libraryItemId] = payload.sessionId.split("__");
        return {
          libraryItemId,
          episodeId: payload.episodeId || null,
          currentTime: payload.currentTime,
          duration: payload.duration,
          progress: payload.progress,
          sessionId: payload.sessionId,
        };
      })
      .filter((item) => item.libraryItemId);

    if (progressItems.length > 0) {
      try {
        await bulkUpsertMediaProgress(supabase, userId, progressItems);
        // All of these sessionIds succeeded
        for (const item of progressItems) {
          syncedSessionIds.push(item.sessionId);
        }
      } catch (e: unknown) {
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
        const { data: existingSessions } = await supabase.from(
          "playback_sessions",
        ).select("id, time_listening").in("id", sessionUuids);

        const existingMap = new Map(
          (existingSessions || []).map((s) => [s.id, s.time_listening || 0]),
        );

        // Update concurrently
        const updatePromises = Array.from(sessionUpdates.entries()).map(
          async ([sessionUuid, update]) => {
            const existingTime = existingMap.get(sessionUuid) || 0;
            try {
              await supabase
                .from("playback_sessions")
                .update({
                  current_time_pos: update.currentTime,
                  time_listening: existingTime + update.timeListened,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", sessionUuid);
            } catch (sessionErr: unknown) {
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
      } catch (e: unknown) {
        console.error(
          `[PlaybackService] Failed to fetch or bulk update playback_sessions:`,
          e,
        );
        return {
          success: false,
          error: getErrorMessage(e) || "Failed to update playback sessions",
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
      } catch (e: unknown) {
        console.error(`[PlaybackService] Failed to close session:`, e);
        return {
          success: false,
          error: getErrorMessage(e) ||
            "Failed to close session and update progress",
        };
      }
    }

    return { success: true };
  }

  static async generateMasterManifest(
    supabase: SupabaseClient<Database>,
    userId: string,
    libraryItemId: string,
    episodeId?: string | null,
  ): Promise<string> {
    const session = await this.startSession(
      supabase,
      userId,
      libraryItemId,
      episodeId,
    );

    const tracks = (session.audioTracks || []) as Array<{
      duration: number;
      title: string;
      contentUrl: string;
    }>;

    if (!tracks.length) {
      throw new Error("No audio tracks available to construct manifest");
    }

    const maxDuration = Math.max(
      ...tracks.map((t) => Math.ceil(Number(t.duration) || 10)),
      10,
    );

    let m3u8 = "#EXTM3U\n";
    m3u8 += "#EXT-X-VERSION:3\n";
    m3u8 += `#EXT-X-TARGETDURATION:${maxDuration}\n`;
    m3u8 += "#EXT-X-PLAYLIST-TYPE:VOD\n";
    m3u8 += "#EXT-X-MEDIA-SEQUENCE:0\n";

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const dur = Number(track.duration) || 0;
      if (i > 0) {
        m3u8 += "#EXT-X-DISCONTINUITY\n";
      }
      m3u8 += `#EXTINF:${dur.toFixed(3)},${track.title || `Track ${i + 1}`}\n`;
      m3u8 += `${track.contentUrl}\n`;
    }

    m3u8 += "#EXT-X-ENDLIST\n";
    return m3u8;
  }
}
