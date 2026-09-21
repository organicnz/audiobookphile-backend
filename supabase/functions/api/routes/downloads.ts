import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { StorageRouter } from "../../_shared/storage-router.ts";
import { getConfiguredTiers } from "../../_shared/b2-config.ts";
import { requireAdminRole } from "../_shared/auth.ts";
import { presignUpload } from "../../_shared/uploadPresign.ts";
import { assertStorageQuota } from "../../_shared/storage-quota.ts";
import {
  analyzeItemWarnings,
  MAX_ITEM_DURATION_S,
  MAX_SINGLE_TRACK_DURATION_S,
  parseTrackDuration,
} from "../../_shared/invariants.ts";
import { Context } from "hono";
import { Variables } from "../_shared/types.ts";
import { getErrorMessage } from "../_shared/errors.ts";
import { naturalSortFilenames } from "../../_shared/zai.ts";
import {
  findDuplicateBook as checkDuplicateBook,
  resolveTitleAndAuthor,
} from "../_shared/domain/downloads.ts";
import {
  isAudioFileName,
  resolveAudioMediaInfo,
} from "../_shared/domain/playback.ts";

// ===== Zod schemas for /upload/finalize =====
const UploadCheckSchema = z.object({
  title: z.string().max(512).optional(),
  author: z.string().max(256).optional(),
  library: z.string().min(1, "Library ID is required"),
});

const UploadFinalizeSchema = z.object({
  bookId: z.string().uuid().optional(),
  title: z.string().max(512).optional(),
  author: z.string().max(256).optional(),
  series: z.string().max(256).optional(),
  library: z.string().min(1, "Library ID is required"), // must be a valid UUID (library_id)
  mediaType: z.enum(["book", "audiobook", "podcast"]).default("book")
    .optional(),
  files: z.array(z.object({
    storagePath: z.string().min(1, "storage path is required"),
    size: z.number().min(0, "Size must be non-negative"),
    name: z.string().max(512).optional(),
    type: z.string().max(512).optional(),
    // Optional client-probed duration (seconds). Browser can read this via
    // HTMLAudioElement.preloaded metadata before finalize; backend sanitizes
    // with invariants (positive, finite, <=24h/track) and sums for item total.
    // Absent/zero means "unknown" — never infer from stale DB totals.
    duration: z.number().min(0).max(MAX_SINGLE_TRACK_DURATION_S).optional(),
  })).min(1, "At least one file is required").optional(),
  overwrite: z.boolean().optional(),
});

const PresignSchema = z.object({
  filename: z.string().min(1, "Filename is required"),
  contentType: z.string().min(1, "Content-Type is required").optional(),
});

const ErrorSchema = z.object({ error: z.string() });

const downloadItemRoute = {
  method: "get" as const,
  path: "/{id}/download",
  tags: ["downloads"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Manifest for download",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    404: {
      description: "Item not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const downloadFileRoute = {
  method: "get" as const,
  path: "/{id}/file/{fileId}/download",
  tags: ["downloads"],
  request: {
    params: z.object({ id: z.string(), fileId: z.string() }),
  },
  responses: {
    200: {
      description: "Signed URL for file",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    404: {
      description: "File not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const uploadPresignLegacyRoute = {
  method: "post" as const,
  path: "/upload-presign",
  tags: ["downloads"],
  responses: {
    200: {
      description: "Presigned URL",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const uploadPresignRoute = {
  method: "post" as const,
  path: "/upload/presign",
  tags: ["downloads"],
  responses: {
    200: {
      description: "Presigned URL",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const uploadFinalizeRoute = {
  method: "post" as const,
  path: "/upload/finalize",
  tags: ["downloads"],
  request: {
    body: { content: { "application/json": { schema: UploadFinalizeSchema } } },
  },
  responses: {
    200: {
      description: "Finalize upload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Conflict (Duplicate Book)",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            existingId: z.string().optional(),
          }),
        },
      },
    },
    500: {
      description: "Server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            detail: z.string().optional(),
          }),
        },
      },
    },
  },
};

const uploadCheckRoute = {
  method: "post" as const,
  path: "/upload/check",
  tags: ["downloads"],
  request: {
    body: { content: { "application/json": { schema: UploadCheckSchema } } },
  },
  responses: {
    200: {
      description: "Check result",
      content: {
        "application/json": {
          schema: z.object({
            exists: z.boolean(),
            existingItem: z.record(z.string(), z.any()).optional(),
          }),
        },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

export const downloadsRouter = createOpenApiRouter();

downloadsRouter.openapi(downloadItemRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryItemId } = c.req.valid("param");

  // Fetch the item and its audio files
  const { data: item, error: itemError } = await supabase
    .from("library_items")
    .select(
      `
      *,
      book_authors (
        authors (
          *
        )
      )
    `,
    )
    .eq("id", libraryItemId)
    .maybeSingle();

  if (itemError || !item) {
    return c.json({
      error: `Library item not found: ${itemError?.message || ""}`,
    }, 404);
  }

  let audioFilesList =
    ((item as Record<string, unknown>)?.audio_files || []) as Record<
      string,
      unknown
    >[];

  if (
    !audioFilesList.length &&
    Array.isArray((item as Record<string, unknown>)?.library_files)
  ) {
    const libraryFiles = (item as Record<string, unknown>)
      .library_files as Record<string, unknown>[];
    audioFilesList = libraryFiles
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
          metadata.filename || metadata.relPath || lf.path || "",
        );
        const { mimeType, codec } = resolveAudioMediaInfo({
          filename,
          ext: String(metadata.ext || ""),
          mimeType: String(metadata.mimeType || ""),
          codec: String(metadata.codec || ""),
        });

        return {
          ino: lf.ino,
          index: idx,
          track_index: idx,
          duration: Number(lf.duration) || Number(metadata.duration) || 0,
          size: Number(lf.size) || Number(metadata.size) || 0,
          mimeType,
          codec,
          metadata: metadata,
        };
      });
  }

  if (!audioFilesList.length) {
    return c.json({ error: "No audio files found for this item" }, 404);
  }

  const rawBookDuration = Number((item as any)?.duration) || 0;

  let totalFilesSize = 0;
  const sortedAudioFiles = [...audioFilesList]
    .map((af) => {
      const metadata = ((af as any).metadata as Record<string, unknown>) || {};
      const size = Number(af.size) || Number(metadata.size) || 0;
      totalFilesSize += size;
      return {
        ...af,
        index: af.track_index !== undefined
          ? Number(af.track_index)
          : af.index !== undefined
          ? Number(af.index)
          : 0,
        duration: Number(af.duration) || Number(metadata.duration) || 0,
        size: size,
        mime_type: String(af.mime_type || af.mimeType || "audio/mpeg"),
        codec: String(af.codec || "mp3"),
      };
    })
    .sort((a, b) => a.index - b.index);

  const needsDurationEstimation = sortedAudioFiles.some((af) =>
    af.duration === 0
  );

  // Same bogus-total guard as playbackService: never prorate a stored total
  // >40h or >3x/<1/3x away from the size estimate.
  const sizeEstimateTotal = totalFilesSize > 0 ? totalFilesSize / 12000 : 0;
  let totalBookDuration = rawBookDuration > 0 &&
      rawBookDuration <= MAX_ITEM_DURATION_S
    ? rawBookDuration
    : 0;
  if (
    totalBookDuration > 0 && sizeEstimateTotal > 60 &&
    (totalBookDuration > sizeEstimateTotal * 3 ||
      totalBookDuration < sizeEstimateTotal / 3)
  ) {
    console.warn(
      `[DownloadsRoute] Rejecting implausible stored duration ${rawBookDuration}s (size estimate ~${
        Math.round(sizeEstimateTotal)
      }s)`,
    );
    totalBookDuration = 0;
  }

  // Storage provider
  const storage = new StorageRouter(supabase);

  // 4 hour signed URLs for downloading
  const DOWNLOAD_EXPIRY_SECONDS = 4 * 3600;

  type DownloadTrack = {
    index: number;
    title: string;
    url: string;
    size: number;
    duration: number;
    mimeType: string;
  };

  const resolvedTracks: (DownloadTrack | null)[] = new Array(
    sortedAudioFiles.length,
  ).fill(null);
  const missingTracks: string[] = [];

  const CHUNK_SIZE = 8;
  for (let offset = 0; offset < sortedAudioFiles.length; offset += CHUNK_SIZE) {
    const chunk = sortedAudioFiles.slice(offset, offset + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (af, chunkIdx) => {
        const i = offset + chunkIdx;
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

        try {
          const isLegacyPath = storagePath.startsWith("/") ||
            (!storagePath.includes("://") && storagePath.length > 0);

          if (isLegacyPath) {
            const resolved = await storage.resolveAndSign(
              storagePath,
              libraryItemId,
              DOWNLOAD_EXPIRY_SECONDS,
            );
            finalSignedUrl = resolved.signedUrl;
          } else {
            finalSignedUrl = await storage.getSignedUrl(
              storagePath,
              DOWNLOAD_EXPIRY_SECONDS,
            );
          }
        } catch (e: unknown) {
          // Fallback: try resolving candidates across all tiers
          const filename = storagePath.split("/").pop() ||
            String(metadata.filename || (af as any).filename);
          const mediaId = String((item as any).media_id || "");
          const rawItemPath = String((item as any).path || "").replace(
            /^\/+/,
            "",
          );
          const recordedPrefix = storagePath.includes("://")
            ? storagePath.replace(/^[a-z0-9-_]+:\/\//i, "").split("/").slice(
              0,
              -1,
            )
              .join("/")
            : storagePath.split("/").slice(0, -1).join("/");
          const cleanStoragePath = storagePath.replace(/^[a-z0-9-_]+:\/\//i, "")
            .replace(/^\/+/, "");

          const candidates = [
            `${libraryItemId}/${filename}`,
            mediaId && mediaId !== libraryItemId
              ? `${mediaId}/${filename}`
              : "",
            recordedPrefix && recordedPrefix !== libraryItemId &&
              recordedPrefix !== mediaId
              ? `${recordedPrefix}/${filename}`
              : "",
            rawItemPath ? `${rawItemPath}/${filename}` : "",
            rawItemPath
              ? `${rawItemPath.replace(/^audiobooks\//, "")}/${filename}`
              : "",
            cleanStoragePath,
            cleanStoragePath.replace(/^audiobooks\//, ""),
            filename,
          ].filter(Boolean);

          const resolved = await storage.signFirstExisting(
            Array.from(new Set(candidates)),
            DOWNLOAD_EXPIRY_SECONDS,
          );

          if (resolved) {
            finalSignedUrl = resolved.signedUrl;
          } else {
            const signErr = e as Error;
            console.warn(
              `[DownloadsRoute] Missing storage file at "${storagePath}": ${signErr.message}. Skipping track.`,
            );
            missingTracks.push(storagePath);
            isMissing = true;
          }
        }

        if (!isMissing && finalSignedUrl) {
          resolvedTracks[i] = {
            index: af.index ?? i,
            title: String(
              metadata.filename || (af as any).filename || `Track ${i + 1}`,
            ),
            url: finalSignedUrl,
            size: af.size,
            duration: duration,
            mimeType: af.mime_type,
          };
        }
      }),
    );
  }

  const tracks: DownloadTrack[] = resolvedTracks.filter(
    (t): t is DownloadTrack => t !== null,
  );

  if (tracks.length === 0) {
    return c.json({
      error:
        `All audio files are missing from B2 for item ${libraryItemId} (${missingTracks.length} track(s) not found, probed tiers: ${
          getConfiguredTiers().join(", ") || "none configured"
        }). Cannot download.`,
    }, 404);
  }

  // Get Authors
  const bookAuthors = (item?.book_authors as Record<string, unknown>[]) || [];
  const authors = bookAuthors.map((ba) => ba.authors as Record<string, unknown>)
    .filter(Boolean);
  const authorNames = authors.map((a) => String(a.name));
  const authorName = authorNames.join(", ") || "Unknown Author";

  const manifest = {
    libraryItemId,
    title: String(item?.title || "Unknown Title"),
    author: authorName,
    duration: tracks.reduce((acc, t) => acc + t.duration, 0) ||
      totalBookDuration,
    totalSize: totalFilesSize,
    tracks: tracks,
  };

  return c.json(manifest as Record<string, any>, 200);
});

downloadsRouter.openapi(downloadFileRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryItemId, fileId } = c.req.valid("param");

  const { data: item, error: itemError } = await supabase.from("library_items")
    .select("audio_files, library_files").eq("id", libraryItemId).maybeSingle();

  if (itemError || !item) {
    return c.json({ error: "Item not found" }, 404);
  }

  const audioFiles = (item.audio_files as any[]) || [];
  const libraryFiles = (item.library_files as any[]) || [];
  const allFiles = [...audioFiles, ...libraryFiles];
  const file = allFiles.find((f: any) =>
    String(f.ino) === fileId || String(f.id) === fileId
  );

  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }

  const storagePath = String(
    file.metadata?.path || file.storage_path || file.path || "",
  );
  if (!storagePath) {
    return c.json({ error: "Storage path not found" }, 404);
  }

  const storage = new StorageRouter(supabase);
  const DOWNLOAD_EXPIRY_SECONDS = 4 * 3600;

  try {
    const isLegacyPath = storagePath.startsWith("/") ||
      (!storagePath.includes("://") && storagePath.length > 0);

    if (isLegacyPath) {
      const resolved = await storage.resolveAndSign(
        storagePath,
        libraryItemId,
        DOWNLOAD_EXPIRY_SECONDS,
      );
      return c.json({ url: resolved.signedUrl } as Record<string, any>, 200);
    }

    const signedUrl = await storage.getSignedUrl(
      storagePath,
      DOWNLOAD_EXPIRY_SECONDS,
    );
    return c.json({ url: signedUrl } as Record<string, any>, 200);
  } catch (_e: unknown) {
    // Fallback: try resolving candidates across all tiers
    const filename = storagePath.split("/").pop() || "";
    const cleanStoragePath = storagePath.replace(/^[a-z0-9-_]+:\/\//i, "")
      .replace(/^\/+/, "");
    const candidates = [
      `${libraryItemId}/${filename}`,
      cleanStoragePath,
      cleanStoragePath.replace(/^audiobooks\//, ""),
      filename,
    ].filter(Boolean);

    const resolved = await storage.signFirstExisting(
      Array.from(new Set(candidates)),
      DOWNLOAD_EXPIRY_SECONDS,
    );

    if (resolved) {
      return c.json({ url: resolved.signedUrl } as Record<string, any>, 200);
    }
    return c.json({ error: (_e as Error).message }, 404);
  }
});

async function handleUploadPresign(c: Context<{ Variables: Variables }>) {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Not authorized" }, 403);
  }
  const supabase = c.get("supabase");

  // Instead of manual parse, we could use c.req.valid("json") but to keep it simple and handle route reuse:
  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema
  const parsed = PresignSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation error",
        details: parsed.error.flatten().fieldErrors,
      } as any,
      400,
    );
  }

  const { filename, contentType } = parsed.data;

  // 10x pro: presign is B2-only for audio – do not mint supabase:// for .mp3/.m4b
  // (prevents the 7.5 GB blow-up). If caller requests an image cover, route to covers quota check.
  if (contentType?.startsWith("image/") || filename.includes("/cover.")) {
    // cover path – ensure Supabase quota allows it (estimate 500 KiB if unknown)
    try {
      await assertStorageQuota(supabase, 512 * 1024);
    } // @ts-ignore
    catch (q: any) {
      if (q?.status === 507) {
        return c.json(
          { error: q.message, code: "STORAGE_QUOTA_EXCEEDED" },
          507 as any,
        );
      }
      throw q;
    }
  }

  try {
    const res = await presignUpload(supabase, filename, contentType);
    return c.json(res as Record<string, any>, 200);
  } catch (e: unknown) {
    return c.json({ error: getErrorMessage(e) }, 500);
  }
}

downloadsRouter.openapi(uploadPresignLegacyRoute, handleUploadPresign);
downloadsRouter.openapi(uploadPresignRoute, handleUploadPresign);

// -----------------------------------------------------------------------------
// upload-finalize: Consolidated API route (port from legacy edge function)
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// upload-finalize: Consolidated API route (port from legacy edge function)
//
// NOTE: this handler intentionally performs NO background/detached work.
// Earlier versions ran music-metadata duration extraction and Z.AI metadata
// enrichment in EdgeRuntime.waitUntil tasks; the dynamic music-metadata import
// combined with the already-heavy edge bundle (AWS SDK, hono, zod, jose) pushed
// the worker past the memory limit, killing the isolate mid-request and
// producing 503s with empty bodies. Durations are computed on demand via
// POST /api/items/:id/sync-durations; enrichment is available via the metadata
// routes. See finalize_test.ts for the handler's behavioral contract.
// -----------------------------------------------------------------------------
export async function executeFinalize(
  c: {
    req: { json(): Promise<unknown> };
    get(key: string): unknown;
    json(payload: unknown, status?: number): unknown;
  },
  overrides?: { supabase?: any; storageRouter?: any },
): Promise<{ status: number; json: Record<string, unknown> }> {
  // Auth: any authenticated non-banned user (user, admin, root) — banned
  // users are rejected earlier by authMiddleware.
  const user = c.get("user") as { id: string } | undefined;
  if (!user) {
    return { status: 401, json: { error: "Not authorized" } };
  }

  const supabase = overrides?.supabase ?? c.get("supabase");
  const storageRouter = overrides?.storageRouter ??
    new StorageRouter(supabase);

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return { status: 400, json: { error: "Invalid JSON" } };
  }

  // Validate with Zod schema (raw title/author before parsing)
  const parsed = UploadFinalizeSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      json: {
        error: "Validation error",
        details: parsed.error.flatten().fieldErrors,
      },
    };
  }

  let {
    bookId,
    title: rawTitle = "",
    author: rawAuthor = "",
    series = "",
    library: libraryId,
    mediaType = "book",
    files,
    overwrite,
  } = parsed.data;

  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";
  const { title, author } = await resolveTitleAndAuthor(
    rawTitle,
    rawAuthor,
    zaiApiKey,
  );

  const validFiles = files || [];
  if (!bookId && !title) {
    return { status: 400, json: { error: "Missing title or bookId fields" } };
  }

  // --- Check for missing files in storage + duplicate detection in parallel ---
  const [missingFiles, existingItem] = await Promise.all([
    (async () => {
      const missing: string[] = [];
      const fileCheckPromises = validFiles.map(async (file: any) => {
        const exists = await storageRouter.fileExists(file.storagePath);
        return exists ? null : file.storagePath;
      });
      const checkResults = await Promise.all(fileCheckPromises);
      missing.push(...checkResults.filter((r): r is string => r !== null));
      return missing;
    })(),
    checkDuplicateBook(
      supabase,
      title,
      author,
      libraryId,
      zaiApiKey,
      bookId,
    ),
  ]);

  if (missingFiles.length > 0) {
    return {
      status: 400,
      json: { error: "Files missing in storage", missingFiles },
    };
  }

  // Basic file structure validation (required fields must be present and non-empty)
  for (const f of validFiles) {
    if (
      !f.storagePath || !f.size || typeof f.size !== "number" || f.size <= 0
    ) {
      return {
        status: 400,
        json: {
          error:
            `File ${f.name} is invalid: missing or invalid storage path/size`,
        },
      };
    }
  }

  const totalSize = validFiles.reduce(
    (sum: number, f: any) => sum + f.size,
    0,
  );

  let libraryItemId = crypto.randomUUID();
  if (existingItem) {
    if (!overwrite) {
      // Clean up orphaned files just uploaded to B2 under the new UUID folder.
      // Audio is B2-only (Supabase storage is covers/light only), so delete
      // via the StorageRouter's B2 delete — never via audio-files bucket.
      if (bookId !== existingItem.id && bookId !== existingItem.media_id) {
        try {
          const filePathsToDelete = validFiles.map((f: any) => f.storagePath);
          if (filePathsToDelete.length > 0) {
            if (
              storageRouter && typeof storageRouter.deletePath === "function"
            ) {
              await Promise.all(
                filePathsToDelete.map((p: string) =>
                  storageRouter.deletePath(p).catch(() => false)
                ),
              );
              console.info(
                `[upload-finalize] Cleaned up ${filePathsToDelete.length} orphaned B2 objects for ${bookId}`,
              );
            }
          }
        } catch (e) {
          console.warn(
            "[upload-finalize] Exception cleaning up orphaned files:",
            e,
          );
        }
      }
      return {
        status: 409,
        json: { error: "Book already exists", existingId: existingItem.id },
      };
    }
    libraryItemId = existingItem.id;
    bookId = existingItem.media_id || existingItem.id;
    console.info(
      `[upload-finalize] Rebinding upload to existing book record: ${libraryItemId} ("${existingItem.title}")`,
    );
  }

  let baseIndex = 0;
  let finalAudioFiles: any[] = [];
  if (existingItem) {
    finalAudioFiles = existingItem.audio_files || [];
    baseIndex = finalAudioFiles.reduce(
      (max: number, af: any) => Math.max(max, af.index || 0),
      0,
    );
    // NOTE: deliberately NOT carrying existingItem.duration forward.
    // The item total is recomputed below from merged per-track durations.
    // Carrying the old total is how the Dark Psychology 281072s (~78h) lie
    // survived re-uploads: new tracks arrive with duration 0 and playback
    // prorated the stale total across them. Unknown stays 0, never stale.
  }

  const sanitizeClientDuration = (v: unknown): number => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
    if (n > MAX_SINGLE_TRACK_DURATION_S) return 0;
    return n;
  };

  const audioFilesJson = validFiles.map((file: any, i: number) => {
    const extRaw = file.name.split(".").pop()?.toLowerCase() ?? "";
    const ext = "." + extRaw;
    const { mimeType, codec } = resolveAudioMediaInfo({
      filename: file.name,
      ext: extRaw,
      mimeType: file.type,
    });
    const probedDuration = sanitizeClientDuration(file.duration);

    return {
      index: baseIndex + i + 1,
      ino: crypto.randomUUID(),
      duration: probedDuration,
      codec,
      metadata: {
        filename: file.name,
        ext,
        path: file.storagePath,
        relPath: file.name,
        size: file.size,
        duration: probedDuration,
        codec,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        birthtimeMs: Date.now(),
        mimeType,
      },
      addedAt: Date.now(),
      updatedAt: Date.now(),
      mimeType,
    };
  });

  finalAudioFiles = [...finalAudioFiles, ...audioFilesJson];

  // Deduplicate files by filename so re-uploading doesn't create duplicate chapters.
  // Merge rule: newest path/size wins, but a zero-duration re-upload must NOT
  // clobber a known-good per-track duration (that erases the only ground truth
  // and forces size-based estimation on next play).
  const uniqueFilesMap = new Map<string, any>();
  for (const af of finalAudioFiles) {
    const key = af.metadata?.filename;
    if (!key) continue;
    const prev = uniqueFilesMap.get(key);
    if (!prev) {
      uniqueFilesMap.set(key, af);
      continue;
    }
    const prevDur = parseTrackDuration(prev) ?? 0;
    const nextDur = parseTrackDuration(af) ?? 0;
    if (nextDur > 0) {
      uniqueFilesMap.set(key, af);
    } else if (prevDur > 0) {
      // Keep proven duration, adopt fresh storage location.
      uniqueFilesMap.set(key, {
        ...af,
        duration: prevDur,
        metadata: { ...af.metadata, duration: prevDur },
      });
    } else {
      uniqueFilesMap.set(key, af);
    }
  }
  let deduplicatedFiles = Array.from(uniqueFilesMap.values());

  // --- SEQUENCE SORTING: fast natural sort (deterministic, no AI needed) ---
  const filenames = deduplicatedFiles.map((af: any) =>
    af.metadata?.filename || af.metadata?.relPath || ""
  ).filter(Boolean);

  if (filenames.length > 1) {
    const sortedFilenames = naturalSortFilenames(filenames);
    const filenameOrderMap = new Map<string, number>();
    sortedFilenames.forEach((name: string, index: number) =>
      filenameOrderMap.set(name, index)
    );

    deduplicatedFiles.sort((a: any, b: any) => {
      const nameA = a.metadata?.filename || a.metadata?.relPath || "";
      const nameB = b.metadata?.filename || b.metadata?.relPath || "";
      const orderA = filenameOrderMap.get(nameA) ?? 999;
      const orderB = filenameOrderMap.get(nameB) ?? 999;
      return orderA - orderB;
    });
  }

  deduplicatedFiles.forEach((af: any, idx: number) => (af.index = idx + 1));

  // 10x pro: item duration is ALWAYS derived from merged per-track ground
  // truth. 0 = unknown (playback falls back to size estimate). Never carry a
  // stale total — a bogus 78h total must not survive a re-upload, and a fresh
  // upload with zero probed durations must not invent one.
  const summedDuration = deduplicatedFiles.reduce(
    (sum: number, af: any) => sum + (parseTrackDuration(af) ?? 0),
    0,
  );
  const recomputedDuration = summedDuration > 0 &&
      summedDuration <= MAX_ITEM_DURATION_S
    ? Math.round(summedDuration)
    : 0;

  if (existingItem) {
    // Update the existing record (files merged into its existing audio_files)
    const { error: bookError } = await supabase
      .from("library_items")
      .update({
        audio_files: deduplicatedFiles,
        duration: recomputedDuration,
        title: title || existingItem.title,
      })
      .eq("id", libraryItemId);
    if (bookError) {
      console.error(
        "[upload-finalize] Failed to update library_item:",
        bookError,
      );
      return {
        status: 500,
        json: {
          error: "Failed to update library record",
          detail: bookError.message,
        },
      };
    }
  } else {
    // New book: insert a fresh record. NOTE: a no-op UPDATE must never be
    // used as the "does it exist?" probe — PostgREST returns no error for a
    // zero-row update, which previously caused NEW books to silently never be
    // created (200 OK with no row in the DB).
    const res = await supabase.from("library_items").insert({
      id: libraryItemId,
      library_id: libraryId,
      media_type: mediaType,
      media_id: bookId,
      path: `${libraryId}/${title}`,
      rel_path: title,
      title,
      audio_files: deduplicatedFiles,
      duration: recomputedDuration,
      size: totalSize,
      is_missing: false,
      last_storage_check: new Date().toISOString(),
    });
    if (res.error) {
      console.error(
        "[upload-finalize] Failed to insert library_item:",
        res.error,
      );
      return {
        status: 500,
        json: {
          error: "Failed to create library record",
          detail: res.error.message,
        },
      };
    }
  }

  const newLibraryFiles = audioFilesJson.map((af: any) => ({
    ino: af.ino,
    metadata: af.metadata,
    addedAt: af.addedAt,
    updatedAt: af.updatedAt,
    isSupplementary: false,
  }));

  let finalLibraryFiles = newLibraryFiles;
  if (existingItem) {
    const allLibFiles = [
      ...(existingItem.library_files || []),
      ...newLibraryFiles,
    ];
    const uniqueLibMap = new Map<string, any>();
    for (const lf of allLibFiles) {
      if (lf.metadata?.filename) {
        uniqueLibMap.set(lf.metadata.filename, lf);
      }
    }
    finalLibraryFiles = Array.from(uniqueLibMap.values());
  }
  const finalSize = (existingItem?.size || 0) + totalSize;

  const { error: itemError } = await supabase
    .from("library_items")
    .update({
      size: finalSize,
      library_files: finalLibraryFiles,
      last_storage_check: new Date().toISOString(),
    })
    .eq("id", libraryItemId);

  if (itemError) {
    console.error(
      "[upload-finalize] Failed to update library_item (post-insert):",
      itemError,
    );
    return {
      status: 500,
      json: {
        error: "Failed to update library record",
        detail: itemError.message,
      },
    };
  }

  // --- Handle author and series metadata updates ---
  if (author) {
    await supabase.from("book_authors").delete().eq(
      "library_item_id",
      libraryItemId,
    );

    const rawAuthors = author
      .split(/\s*(?:\/|,|&|\band\b)\s*/i)
      .map((a: string) => a.trim())
      .filter(Boolean);

    const cleanAuthors = rawAuthors
      .map((a: string) => {
        let name = a;
        const dashSplit = name.split(" - ");
        if (dashSplit.length > 1) {
          const lowerTitle = (title || "").toLowerCase();
          if (
            lowerTitle &&
            (dashSplit[0].toLowerCase() === lowerTitle ||
              lowerTitle.includes(dashSplit[0].toLowerCase()))
          ) {
            name = dashSplit[1];
          } else if (
            lowerTitle &&
            (dashSplit[1].toLowerCase() === lowerTitle ||
              lowerTitle.includes(dashSplit[1].toLowerCase()))
          ) {
            name = dashSplit[0];
          } else {
            name = dashSplit[0];
          }
        }
        name = name.replace(/\b(Ph\.?D\.?|M\.?D\.?)\b/gi, "");
        name = name.replace(/([A-Za-z])\./g, "$1");
        name = name.replace(/\s+/g, " ").trim();
        if (title && name.toLowerCase() === title.toLowerCase()) {
          return "";
        }
        return name;
      })
      .filter(Boolean);

    const uniqueAuthors = Array.from(new Set(cleanAuthors));

    for (const singleAuthor of uniqueAuthors) {
      await supabase.from("authors").upsert(
        {
          id: crypto.randomUUID(),
          name: singleAuthor,
          library_id: libraryId,
        },
        { onConflict: "library_id, name", ignoreDuplicates: true },
      );

      const { data: existingAuthor } = await supabase.from("authors").select(
        "id",
      ).eq("name", singleAuthor).eq("library_id", libraryId).maybeSingle();

      const authorId = existingAuthor?.id;
      if (authorId) {
        await supabase.from("book_authors").upsert(
          {
            library_item_id: libraryItemId,
            author_id: authorId,
          },
          {
            onConflict: "library_item_id, author_id",
            ignoreDuplicates: true,
          },
        );
      }
    }

    await supabase
      .from("library_items")
      .update({
        author_names_first_last: author,
      })
      .eq("id", libraryItemId);
  }

  if (series) {
    await supabase.from("book_series").delete().eq(
      "library_item_id",
      libraryItemId,
    );

    const rawSeries: string[] = series
      .split(/\s*(?:\/|,|&|\band\b)\s*/i)
      .map((s: string) => s.trim())
      .filter((s: string) => Boolean(s));
    const uniqueSeries = Array.from(new Set(rawSeries));

    for (const singleSeries of uniqueSeries) {
      await supabase.from("series").upsert(
        {
          id: crypto.randomUUID(),
          name: singleSeries,
          library_id: libraryId,
        },
        { onConflict: "library_id, name", ignoreDuplicates: true },
      );

      const { data: existingSeries } = await supabase.from("series").select(
        "id",
      ).eq("name", singleSeries).eq("library_id", libraryId).maybeSingle();

      const seriesId = existingSeries?.id;
      if (seriesId) {
        await supabase.from("book_series").upsert(
          {
            library_item_id: libraryItemId,
            series_id: seriesId,
          },
          {
            onConflict: "library_item_id, series_id",
            ignoreDuplicates: true,
          },
        );
      }
    }
  }

  // Surface data-integrity warnings (stowaway/giant tracks) with the response
  // so upload clients and admins see them instead of silent corruption.
  const finalizeWarnings = analyzeItemWarnings(
    deduplicatedFiles as Array<Record<string, unknown>>,
  );
  if (finalizeWarnings.length > 0) {
    console.warn(
      `[upload-finalize] warnings for ${libraryItemId}:`,
      JSON.stringify(finalizeWarnings),
    );
  }

  return {
    status: 200,
    json: {
      success: true,
      libraryItemId,
      bookId,
      duration: recomputedDuration,
      durationSource: summedDuration > 0
        ? "sum(track_durations)"
        : "unknown(0)",
      ...(finalizeWarnings.length > 0 ? { warnings: finalizeWarnings } : {}),
    },
  };
}

downloadsRouter.openapi(uploadFinalizeRoute, async (c) => {
  try {
    const result = await executeFinalize(c);
    return c.json(
      result.json as any,
      result.status as 200 | 400 | 401 | 409 | 500,
    );
  } catch (err) {
    console.error(
      "[upload-finalize] Unhandled error:",
      (err as Error).message,
      err,
    );
    return c.json(
      { error: "Finalization failed", detail: (err as Error).message },
      500,
    );
  }
});

downloadsRouter.openapi(uploadCheckRoute, async (c) => {
  try {
    const user = c.get("user");
    if (!requireAdminRole(user)) {
      return c.json({ error: "Forbidden: Admin access required" }, 401);
    }
    const supabase = c.get("supabase");

    let body;
    try {
      body = await c.req.json();
    } catch (_e) {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = UploadCheckSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Validation error",
          details: parsed.error.flatten().fieldErrors,
        } as Record<string, any>,
        400,
      );
    }

    const { title: rawTitle = "", author: rawAuthor = "", library: libraryId } =
      parsed.data;

    const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
      Deno.env.get("ZHIPU_API_KEY") ?? "";
    const { title, author } = await resolveTitleAndAuthor(
      rawTitle,
      rawAuthor,
      zaiApiKey,
    );

    if (!title) {
      return c.json({ error: "Missing book title" }, 400);
    }

    const existingItem = await checkDuplicateBook(
      supabase,
      title,
      author,
      libraryId,
      zaiApiKey,
    );

    if (existingItem) {
      return c.json(
        {
          exists: true,
          existingItem: {
            id: existingItem.id,
            title: existingItem.title,
            author: existingItem.author_names_first_last,
          },
        } as { exists: boolean; existingItem?: Record<string, any> },
        200,
      );
    }

    return c.json(
      { exists: false } as {
        exists: boolean;
        existingItem?: Record<string, any>;
      },
      200,
    );
  } catch (err) {
    return c.json(
      { error: "Check failed", detail: (err as Error).message },
      500,
    );
  }
});
