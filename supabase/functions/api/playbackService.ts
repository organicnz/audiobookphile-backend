import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { Database } from "../../../src/types/supabase.ts";
import { StorageRouter } from "../_shared/storage-router.ts";
import { getConfiguredTiers } from "../_shared/b2-config.ts";
import { resolveBookStorage } from "../_shared/intelligentStorageResolver.ts";
import {
  bulkUpsertMediaProgress,
  upsertMediaProgress,
} from "../_shared/progress.ts";
import { getErrorMessage } from "./_shared/errors.ts";
import {
  AUDIO_EXTENSIONS,
  generateManifest,
  inferAudioCodec,
  inferMimeType,
  isAudioFileName,
  normalizeAudioFile,
  normalizeAudioFiles,
  resolveAudioMediaInfo,
  resolveSyncConflict,
} from "./_shared/domain/playback.ts";

export {
  AUDIO_EXTENSIONS,
  generateManifest,
  inferAudioCodec,
  inferMimeType,
  isAudioFileName,
  normalizeAudioFile,
  normalizeAudioFiles,
  resolveAudioMediaInfo,
  resolveSyncConflict,
};

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
      const extracted = libraryFiles
        .filter((lf) => {
          const metadata = (lf.metadata as Record<string, unknown>) || {};
          const ext = String(metadata.ext || "");
          const relPath = String(
            metadata.relPath || metadata.filename || lf.path || "",
          );
          return isAudioFileName(ext) || isAudioFileName(relPath);
        })
        .map((lf, idx) => {
          const metadata = (lf.metadata as Record<string, unknown>) || {};
          const filename = String(
            metadata.filename || metadata.relPath || `Track ${idx + 1}`,
          );
          const { mimeType, codec } = resolveAudioMediaInfo({
            filename,
            ext: String(metadata.ext || ""),
            mimeType: String(metadata.mimeType || ""),
            codec: String(metadata.codec || ""),
          });

          return {
            index: idx,
            ino: lf.ino,
            metadata: metadata,
            size: Number(lf.size) || Number(metadata.size) || 0,
            duration: Number(lf.duration) || Number(metadata.duration) || 0,
            mime_type: mimeType,
            codec: codec,
            filename,
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

        const filename = String(
          (af as any).filename || metadata.filename || metadata.relPath || "",
        );
        const { mimeType, codec } = resolveAudioMediaInfo({
          filename,
          ext,
          mimeType: String(
            af.mime_type || af.mimeType || metadata.mimeType || "",
          ),
          codec: String(af.codec || metadata.codec || ""),
        });

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

    const mediaId = String((item as any).media_id || "");
    const rawItemPath = String((item as any).path || "").replace(/^\/+/, "");
    const relPath = String((item as any).rel_path || "").replace(/^\/+/, "");
    const strippedItemPath = rawItemPath
      .replace(/^[0-9a-fA-F-]{36}\/?/, "")
      .replace(/^audiobooks\//, "");

    // Helper to build candidate storage keys for a track's file
    const buildCandidates = (
      storagePath: string,
      filename: string,
    ): string[] => {
      const cleanStoragePath = storagePath
        .replace(/^[a-z0-9-_]+:\/\//i, "")
        .replace(/^\/+/, "");
      const recordedPrefix = cleanStoragePath.includes("/")
        ? cleanStoragePath.split("/").slice(0, -1).join("/")
        : "";

      const rawCandidates = [
        `${libraryItemId}/${filename}`,
        mediaId && mediaId !== libraryItemId ? `${mediaId}/${filename}` : "",
        recordedPrefix && recordedPrefix !== libraryItemId &&
          recordedPrefix !== mediaId
          ? `${recordedPrefix}/${filename}`
          : "",
        relPath ? `${relPath}/${filename}` : "",
        relPath ? `audiobooks/${relPath}/${filename}` : "",
        strippedItemPath ? `${strippedItemPath}/${filename}` : "",
        strippedItemPath ? `audiobooks/${strippedItemPath}/${filename}` : "",
        rawItemPath ? `${rawItemPath}/${filename}` : "",
        rawItemPath
          ? `${rawItemPath.replace(/^audiobooks\//, "")}/${filename}`
          : "",
        cleanStoragePath,
        cleanStoragePath.replace(/^audiobooks\//, ""),
        filename,
      ].filter(Boolean);

      const candidateSet = new Set<string>();
      for (const cand of rawCandidates) {
        candidateSet.add(cand);
        try {
          const decoded = decodeURIComponent(cand);
          if (decoded !== cand) candidateSet.add(decoded);
        } catch {
          // ignore malformed URI components
        }
      }

      return Array.from(candidateSet);
    };

    // Prepare metadata for all sorted audio files
    interface PreparedTrack {
      af: (typeof sortedAudioFiles)[0];
      index: number;
      duration: number;
      storagePath: string;
      filename: string;
      metadata: Record<string, unknown>;
      finalSignedUrl: string;
      resolvedCanonicalPath: string | null;
      isMissing: boolean;
    }

    const preparedTracks: PreparedTrack[] = sortedAudioFiles.map((af, i) => {
      const metadata = ((af as any).metadata as Record<string, unknown>) || {};
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

      const rawFilename = String(
        metadata.filename || (af as any).filename || metadata.relPath || "",
      );
      const cleanStorage = storagePath.replace(/^[a-z0-9-_]+:\/\//i, "")
        .replace(/^\/+/, "");
      const filename =
        (rawFilename || cleanStorage.split("/").pop() || `Track ${i + 1}`)
          .trim()
          .replace(/^\/+/, "")
          .split("/")
          .pop() || `Track ${i + 1}`;

      return {
        af,
        index: af.index ?? i,
        duration,
        storagePath,
        filename,
        metadata,
        finalSignedUrl: "",
        resolvedCanonicalPath: null,
        isMissing: false,
      };
    });

    // --- Single-Probe Folder Template Derivation ---
    // All audio tracks in an audiobook reside in the same bucket tier under the same prefix.
    // Probing track 0 (with fallback to track 1) discovers the canonical tier and prefix in <200ms,
    // allowing all remaining tracks to be presigned locally via HMAC in <5ms without network calls.
    const firstTrack = preparedTracks[0];
    const isFirstLegacy = firstTrack.storagePath.startsWith("/") ||
      (!firstTrack.storagePath.includes("://") &&
        firstTrack.storagePath.length > 0);

    let winningPrefix: string | null = null;

    if (isFirstLegacy) {
      try {
        const resolved = await storage.resolveAndSign(
          firstTrack.storagePath,
          libraryItemId,
          604800,
        );
        firstTrack.finalSignedUrl = resolved.signedUrl;
        firstTrack.resolvedCanonicalPath = resolved.canonicalPath;
        const lastSlash = resolved.canonicalPath.lastIndexOf("/");
        winningPrefix = lastSlash !== -1
          ? resolved.canonicalPath.slice(0, lastSlash + 1)
          : "";
      } catch {
        // resolveAndSign failed, fall through to candidate probe
      }
    } else {
      const exists = await storage.fileExists(firstTrack.storagePath).catch(
        () => false,
      );
      if (exists) {
        try {
          firstTrack.finalSignedUrl = await storage.getSignedUrl(
            firstTrack.storagePath,
            604800,
          );
          const lastSlash = firstTrack.storagePath.lastIndexOf("/");
          winningPrefix = lastSlash !== -1
            ? firstTrack.storagePath.slice(0, lastSlash + 1)
            : "";
        } catch {
          // presign threw, fall through to candidate probe
        }
      }
    }

    // If first track couldn't be presigned / verified, probe cross-tier candidate keys
    if (!firstTrack.finalSignedUrl) {
      const candidates0 = buildCandidates(
        firstTrack.storagePath,
        firstTrack.filename,
      );
      const resolved0 = await storage.signFirstExisting(candidates0, 604800);
      if (resolved0) {
        firstTrack.finalSignedUrl = resolved0.signedUrl;
        firstTrack.resolvedCanonicalPath = resolved0.canonicalPath;
        const lastSlash = resolved0.canonicalPath.lastIndexOf("/");
        winningPrefix = lastSlash !== -1
          ? resolved0.canonicalPath.slice(0, lastSlash + 1)
          : "";
      } else {
        // Track 0 is missing; mark it and try track 1 fallback
        firstTrack.isMissing = true;
        firstTrack.finalSignedUrl = "";

        if (preparedTracks.length > 1) {
          const secondTrack = preparedTracks[1];
          const candidates1 = buildCandidates(
            secondTrack.storagePath,
            secondTrack.filename,
          );
          const resolved1 = await storage.signFirstExisting(
            candidates1,
            604800,
          );
          if (resolved1) {
            secondTrack.finalSignedUrl = resolved1.signedUrl;
            secondTrack.resolvedCanonicalPath = resolved1.canonicalPath;
            const lastSlash = resolved1.canonicalPath.lastIndexOf("/");
            winningPrefix = lastSlash !== -1
              ? resolved1.canonicalPath.slice(0, lastSlash + 1)
              : "";
          }
        }
      }
    }

    // If standard probes failed, attempt intelligent multi-tier AI/index resolution
    if (
      !winningPrefix &&
      !preparedTracks.some((t) => t.finalSignedUrl && !t.isMissing) &&
      !item.is_missing
    ) {
      try {
        const intelligentMatch = await Promise.race([
          resolveBookStorage(item, firstTrack),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
        ]);
        if (intelligentMatch) {
          firstTrack.isMissing = false;
          firstTrack.finalSignedUrl = intelligentMatch.signedUrl;
          firstTrack.resolvedCanonicalPath = intelligentMatch.canonicalPath;
          winningPrefix = intelligentMatch.winningPrefix;
          console.info(
            `[PlaybackService] Intelligent resolver recovered playback for "${item.title}" (${intelligentMatch.matchedBy}) -> ${winningPrefix}`,
          );
        }
      } catch (intelErr) {
        console.warn(
          `[PlaybackService] Intelligent resolver error for item ${libraryItemId}:`,
          intelErr,
        );
      }
    }

    // Fast-fail: if neither Track 0, Track 1, nor Intelligent Resolver found files, the book does not exist in storage!
    if (
      !winningPrefix &&
      !preparedTracks.some((t) => t.finalSignedUrl && !t.isMissing)
    ) {
      throw new Error(
        `All audio files are missing from B2 for item ${libraryItemId} ` +
          `(${preparedTracks.length} track(s) not found, probed tiers: ` +
          `${getConfiguredTiers().join(", ") || "none configured"}). ` +
          `The book may need to be re-uploaded.`,
      );
    }

    // Sign remaining tracks locally using the winning prefix (pure local HMAC-SHA256, 0 network requests)
    await Promise.all(
      preparedTracks.map(async (track, idx) => {
        if (track.finalSignedUrl || track.isMissing) {
          return;
        }

        const isTrackLegacy = track.storagePath.startsWith("/") ||
          (!track.storagePath.includes("://") && track.storagePath.length > 0);

        const targetPath = winningPrefix
          ? `${winningPrefix}${track.filename}`
          : (!isTrackLegacy && track.storagePath
            ? track.storagePath
            : `${libraryItemId}/${track.filename}`);

        try {
          track.finalSignedUrl = await storage.getSignedUrl(targetPath, 604800);
          if (winningPrefix || targetPath !== track.storagePath) {
            track.resolvedCanonicalPath = targetPath;
          }
        } catch (signErr) {
          console.warn(
            `[PlaybackService] Failed to presign track ${idx} at "${targetPath}":`,
            signErr,
          );
          track.isMissing = true;
          track.finalSignedUrl = "";
        }
      }),
    );

    // Patch DB in background with resolved canonical paths if any were recovered
    const hasAnyResolvedCanonical = preparedTracks.some(
      (r) => r.resolvedCanonicalPath,
    );
    if (hasAnyResolvedCanonical) {
      (async () => {
        try {
          const { data: currentItem } = await supabase
            .from("library_items")
            .select("audio_files")
            .eq("id", libraryItemId)
            .single();

          if (currentItem?.audio_files) {
            const resolvedMap = new Map<string, string>();
            for (const r of preparedTracks) {
              if (r.resolvedCanonicalPath) {
                if (r.storagePath) {
                  resolvedMap.set(r.storagePath, r.resolvedCanonicalPath);
                }
                if (r.filename) {
                  resolvedMap.set(r.filename, r.resolvedCanonicalPath);
                }
              }
            }

            const updatedFiles = (
              currentItem.audio_files as Record<string, unknown>[]
            ).map((af: Record<string, unknown>) => {
              const afMeta = (af.metadata as Record<string, unknown>) || {};
              const currentPath = String(
                afMeta.path || (af as any).storage_path || (af as any).path ||
                  "",
              );
              const currentFilename = String(
                afMeta.filename || (af as any).filename || "",
              );
              const newCanonical = resolvedMap.get(currentPath) ||
                resolvedMap.get(currentFilename);
              if (newCanonical) {
                return {
                  ...af,
                  storage_path: newCanonical,
                  metadata: {
                    ...afMeta,
                    path: newCanonical,
                  },
                };
              }
              return af;
            });

            await supabase
              .from("library_items")
              .update({
                audio_files: updatedFiles as any,
                is_missing: false,
              })
              .eq("id", libraryItemId);
          }
        } catch (patchErr) {
          console.warn(
            `[PlaybackService] Failed to patch canonical paths for item ${libraryItemId}:`,
            patchErr,
          );
        }
      })();
    } else if ((item as any).is_missing) {
      (async () => {
        try {
          await supabase
            .from("library_items")
            .update({ is_missing: false })
            .eq("id", libraryItemId);
        } catch (e) {
          console.warn(
            `[PlaybackService] Failed to reset is_missing for ${libraryItemId}:`,
            e,
          );
        }
      })();
    }

    let currentOffset = 0;
    const audioTracks: Record<string, unknown>[] = [];
    const missingTracks: string[] = [];

    for (const res of preparedTracks) {
      if (res.isMissing || !res.finalSignedUrl) {
        missingTracks.push(res.storagePath || res.filename);
        continue;
      }

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

    if (audioTracks.length === 0) {
      throw new Error(
        `All audio files are missing from B2 for item ${libraryItemId} ` +
          `(${missingTracks.length} track(s) not found, probed tiers: ` +
          `${getConfiguredTiers().join(", ") || "none configured"}). ` +
          `The book may need to be re-uploaded.`,
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
    const totalDuration = currentOffset > 0
      ? currentOffset
      : (Number((item as any).duration) || 0);
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
