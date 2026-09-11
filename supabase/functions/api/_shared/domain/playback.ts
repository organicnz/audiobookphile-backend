/**
 * Playback Domain Module — Pure business logic for playback operations.
 *
 * Extracted from playbackService.ts to provide independently testable
 * helper functions for session management, sync conflict resolution,
 * and audio manifest generation.
 */

/* =========================================================================
 * Audio File Normalization
 *
 * Audio file metadata arrives in different shapes depending on the source
 * (Audiobookshelf legacy, mobile upload, B2 presigned). This module
 * normalizes all variants into a consistent shape.
 * ========================================================================= */

export interface NormalizedAudioFile {
  id: string;
  index: number;
  filename: string;
  storagePath: string;
  duration: number;
  size: number;
  mimeType: string;
  codec: string;
  bitRate: number;
}

/** Normalize raw audio file JSON (camelCase / snake_case / nested) to a consistent shape. */
export function normalizeAudioFile(
  raw: Record<string, unknown>,
  index: number,
): NormalizedAudioFile {
  const metadata = (raw.metadata || {}) as Record<string, unknown>;

  return {
    id: String(raw.id || raw.ino || crypto.randomUUID()),
    index: Number(raw.index ?? raw.track_index ?? index),
    filename: String(
      raw.filename || metadata.filename || raw.path || `track_${index}`,
    ),
    storagePath: String(
      raw.storage_path || raw.path || raw.relPath || raw.rel_path || "",
    ),
    duration: Number(raw.duration || 0),
    size: Number(raw.size || metadata.size || 0),
    mimeType: String(raw.mime_type || raw.mimeType || "audio/mpeg"),
    codec: String(raw.codec || "mp3"),
    bitRate: Number(raw.bit_rate || raw.bitRate || 128000),
  };
}

/** Normalize an array of raw audio files and sort by index. */
export function normalizeAudioFiles(
  rawFiles: unknown,
): NormalizedAudioFile[] {
  let files: Record<string, unknown>[] = [];

  if (typeof rawFiles === "string") {
    try {
      files = JSON.parse(rawFiles);
    } catch {
      files = [];
    }
  } else if (Array.isArray(rawFiles)) {
    files = rawFiles;
  }

  return files
    .map((f, i) => normalizeAudioFile(f, i))
    .sort((a, b) => a.index - b.index);
}

/* =========================================================================
 * Sync Conflict Resolution
 *
 * When the mobile app syncs playback position, it sends its local state.
 * If the server has a newer position (from another device), we need to
 * resolve the conflict intelligently.
 * ========================================================================= */

export interface SyncInput {
  currentTime: number;
  duration: number;
  updatedAt: number; // epoch ms
  isFinished: boolean;
}

export interface SyncResult {
  winner: "client" | "server";
  currentTime: number;
  isFinished: boolean;
  progress: number;
}

/**
 * Resolve a sync conflict between client and server playback state.
 *
 * Strategy:
 * - Most-recent-write wins (updatedAt timestamp).
 * - Exception: if the client is further ahead in the book, it wins
 *   regardless of timestamp (prevents losing progress from clock skew).
 * - Finished state is sticky (once finished, stays finished).
 */
export function resolveSyncConflict(
  client: SyncInput,
  server: SyncInput,
): SyncResult {
  // Finished is sticky
  if (client.isFinished || server.isFinished) {
    return {
      winner: client.isFinished ? "client" : "server",
      currentTime: client.isFinished ? client.currentTime : server.currentTime,
      isFinished: true,
      progress: 1.0,
    };
  }

  // Client is further ahead → client wins (prevents progress loss)
  if (client.currentTime > server.currentTime + 5) {
    const progress = client.duration > 0
      ? client.currentTime / client.duration
      : 0;
    return {
      winner: "client",
      currentTime: client.currentTime,
      isFinished: false,
      progress: Math.min(progress, 1.0),
    };
  }

  // Most-recent-write wins
  const winner = client.updatedAt >= server.updatedAt ? "client" : "server";
  const winnerState = winner === "client" ? client : server;
  const progress = winnerState.duration > 0
    ? winnerState.currentTime / winnerState.duration
    : 0;

  return {
    winner,
    currentTime: winnerState.currentTime,
    isFinished: false,
    progress: Math.min(progress, 1.0),
  };
}

/* =========================================================================
 * Session Manifest
 * ========================================================================= */

export interface SessionManifest {
  mediaItemId: string;
  tracks: Array<{
    index: number;
    startOffset: number;
    duration: number;
    title: string;
    contentUrl: string;
    mimeType: string;
  }>;
  totalDuration: number;
  totalSize: number;
}

/**
 * Generate a master playback manifest from normalized audio files.
 * Computes cumulative offsets for gapless playback.
 */
export function generateManifest(
  mediaItemId: string,
  files: NormalizedAudioFile[],
  signedUrls: Map<string, string>,
): SessionManifest {
  let cumulativeOffset = 0;
  const tracks = files.map((f) => {
    const track = {
      index: f.index,
      startOffset: cumulativeOffset,
      duration: f.duration,
      title: f.filename,
      contentUrl: signedUrls.get(f.storagePath) || "",
      mimeType: f.mimeType,
    };
    cumulativeOffset += f.duration;
    return track;
  });

  return {
    mediaItemId,
    tracks,
    totalDuration: cumulativeOffset,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
  };
}
