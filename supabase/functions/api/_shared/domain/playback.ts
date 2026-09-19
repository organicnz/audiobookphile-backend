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

export const AUDIO_EXTENSIONS: readonly string[] = [
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
] as const;

/** Check whether a path or extension corresponds to a recognized audio format. */
export function isAudioFileName(pathOrExt: string): boolean {
  const lower = pathOrExt.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Extract clean extension without leading dot. */
export function extractExtension(pathOrFilename: string): string {
  const clean = pathOrFilename.split("?")[0].split("#")[0];
  const lastDot = clean.lastIndexOf(".");
  if (lastDot === -1 || lastDot === clean.length - 1) return "";
  return clean.slice(lastDot + 1).toLowerCase();
}

/** Infer standard MIME type from extension or filename, with optional fallback. */
export function inferMimeType(
  filenameOrExt: string,
  fallbackMime?: string | null,
): string {
  const ext = extractExtension(filenameOrExt) ||
    filenameOrExt.toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "m4b":
    case "m4a":
    case "mp4":
    case "m4v":
      return "audio/mp4";
    case "mp3":
    case "mpeg":
    case "mpg":
      return "audio/mpeg";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/opus";
    case "ogg":
    case "oga":
    case "ogv":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "wav":
      return "audio/wav";
    case "webm":
    case "webma":
      return "audio/webm";
    case "wma":
    case "wmv":
    case "asf":
      return "audio/x-ms-wma";
    case "aiff":
    case "aif":
      return "audio/aiff";
    case "caf":
      return "audio/x-caf";
    case "awb":
    case "3gp":
      return "audio/amr-wb";
    case "mka":
    case "mkv":
      return "audio/x-matroska";
    default:
      return fallbackMime || "audio/mpeg";
  }
}

/** Infer standard audio codec identifier from extension or filename, with optional fallback. */
export function inferAudioCodec(
  filenameOrExt: string,
  fallbackCodec?: string | null,
): string {
  const ext = extractExtension(filenameOrExt) ||
    filenameOrExt.toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "m4b":
    case "m4a":
    case "mp4":
    case "m4v":
    case "aac":
    case "caf":
      return "aac";
    case "flac":
      return "flac";
    case "opus":
      return "opus";
    case "ogg":
    case "oga":
    case "ogv":
      return "vorbis";
    case "wav":
    case "aiff":
    case "aif":
      return "pcm";
    case "wma":
    case "wmv":
    case "asf":
      return "wma";
    case "awb":
    case "3gp":
      return "amr-wb";
    default:
      return fallbackCodec || "mp3";
  }
}

/** Resolve both MIME type and codec from metadata and filenames with safe defaults. */
export function resolveAudioMediaInfo(params: {
  filename?: string;
  ext?: string;
  mimeType?: string | null;
  codec?: string | null;
}): { mimeType: string; codec: string } {
  const extCandidate = params.ext || params.filename || "";
  let mimeType = String(params.mimeType || "");
  if (
    !mimeType || mimeType === "audio/mpeg" ||
    mimeType === "application/octet-stream"
  ) {
    mimeType = inferMimeType(extCandidate, params.mimeType || "audio/mpeg");
  }

  let codec = String(params.codec || "");
  if (!codec || codec === "mp3") {
    codec = inferAudioCodec(extCandidate, params.codec || "mp3");
  }

  return { mimeType, codec };
}

/** Normalize raw audio file JSON (camelCase / snake_case / nested) to a consistent shape. */
export function normalizeAudioFile(
  raw: Record<string, unknown>,
  index: number,
): NormalizedAudioFile {
  const metadata = (raw.metadata || {}) as Record<string, unknown>;
  const filename = String(
    raw.filename || metadata.filename || metadata.relPath ||
      metadata.rel_path || raw.path || `track_${index}`,
  );
  const mediaInfo = resolveAudioMediaInfo({
    filename,
    ext: String(metadata.ext || raw.ext || ""),
    mimeType: String(raw.mime_type || raw.mimeType || metadata.mimeType || ""),
    codec: String(raw.codec || metadata.codec || ""),
  });

  return {
    id: String(raw.id || raw.ino || crypto.randomUUID()),
    index: Number(raw.index ?? raw.track_index ?? index),
    filename,
    // Storage path MUST include metadata.* fallbacks: upload-finalize writes
    // the canonical b2:// URI only into metadata.path, leaving top-level
    // storage_path/path empty. Dropping metadata here yields "" and every
    // downstream signed-URL lookup misses (empty manifest contentUrls).
    // Order matches PlaybackService.startSession's storagePath resolution.
    storagePath: String(
      metadata.path || raw.storage_path || raw.path || raw.relPath ||
        raw.rel_path || metadata.relPath || metadata.rel_path ||
        metadata.filename || raw.filename || "",
    ),
    duration: Number(raw.duration || metadata.duration || 0),
    size: Number(raw.size || metadata.size || 0),
    mimeType: mediaInfo.mimeType,
    codec: mediaInfo.codec,
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
