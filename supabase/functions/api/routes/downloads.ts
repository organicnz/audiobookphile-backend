import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { StorageRouter } from "../../_shared/storage-router.ts";
import { requireAdminRole } from "../_shared/auth.ts";
import { presignUpload } from "../../_shared/uploadPresign.ts";
import { parseTitleAndAuthor } from "../../_shared/titleAuthorParser.ts";
import { Context } from "hono";
import { Variables } from "../_shared/types.ts";
import { getErrorMessage } from "../_shared/errors.ts";
import {
  matchExistingBookWithZAI,
  naturalSortFilenames,
} from "../../_shared/zai.ts";

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
    const audioExtensions = [
      ".mp3",
      ".m4b",
      ".m4a",
      ".aac",
      ".flac",
      ".ogg",
      ".opus",
      ".wma",
    ];
    audioFilesList = libraryFiles
      .filter((lf) => {
        const metadata = (lf.metadata as Record<string, unknown>) || {};
        const ext = String(metadata.ext || "").toLowerCase();
        const relPath = String(
          metadata.relPath || metadata.filename || lf.path || "",
        ).toLowerCase();
        return audioExtensions.some((e) =>
          ext.endsWith(e) || relPath.endsWith(e)
        );
      })
      .map((lf, idx) => {
        const metadata = (lf.metadata as Record<string, unknown>) || {};
        return {
          ino: lf.ino,
          index: idx,
          track_index: idx,
          duration: Number(lf.duration) || Number(metadata.duration) || 0,
          size: Number(lf.size) || Number(metadata.size) || 0,
          mimeType: String(metadata.mimeType || "audio/mpeg"),
          codec: String(metadata.codec || "mp3"),
          metadata: metadata,
        };
      });
  }

  if (!audioFilesList.length) {
    return c.json({ error: "No audio files found for this item" }, 404);
  }

  const totalBookDuration = Number((item as any)?.duration) || 0;

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

  // Storage provider
  const storage = new StorageRouter(supabase);

  // 4 hour signed URLs for downloading
  const DOWNLOAD_EXPIRY_SECONDS = 4 * 3600;

  const tracks = [];
  const missingTracks: string[] = [];

  for (let i = 0; i < sortedAudioFiles.length; i++) {
    const af = sortedAudioFiles[i];
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

    let finalSignedUrl = "";
    let isMissing = false;

    try {
      finalSignedUrl = await storage.getSignedUrl(
        storagePath,
        DOWNLOAD_EXPIRY_SECONDS,
      );
    } catch (e: unknown) {
      const signErr = e as Error;
      console.warn(
        `[DownloadsRoute] Missing storage file at "${storagePath}": ${signErr.message}. Skipping track.`,
      );
      missingTracks.push(storagePath);
      isMissing = true;
    }

    if (!isMissing && finalSignedUrl) {
      tracks.push({
        index: af.index ?? i,
        title: String(
          metadata.filename || (af as any).filename || `Track ${i + 1}`,
        ),
        url: finalSignedUrl,
        size: af.size,
        duration: duration,
        mimeType: af.mime_type,
      });
    }
  }

  if (tracks.length === 0) {
    return c.json({
      error: "All audio files are missing from storage. Cannot download.",
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
    duration: totalBookDuration ||
      tracks.reduce((acc, t) => acc + t.duration, 0),
    totalSize: totalFilesSize,
    tracks: tracks,
  };

  return c.json(manifest as Record<string, any>, 200);
});

downloadsRouter.openapi(downloadFileRoute, async (c) => {
  const supabase = c.get("supabase");
  const { id: libraryItemId, fileId } = c.req.valid("param");

  const { data: item, error: itemError } = await supabase.from("library_items")
    .select("audio_files").eq("id", libraryItemId).maybeSingle();

  if (itemError || !item) {
    return c.json({ error: "Item not found" }, 404);
  }

  const audioFiles = (item.audio_files as any[]) || [];
  const file = audioFiles.find((f: any) =>
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
    const signedUrl = await storage.getSignedUrl(
      storagePath,
      DOWNLOAD_EXPIRY_SECONDS,
    );
    return c.json({ url: signedUrl } as Record<string, any>, 200);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
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
      // Clean up orphaned files that were just uploaded to the new UUID folder
      if (bookId !== existingItem.id && bookId !== existingItem.media_id) {
        try {
          const filePathsToDelete = validFiles.map((f: any) => f.storagePath);
          if (filePathsToDelete.length > 0) {
            const { error: delErr } = await supabase.storage.from(
              "audio-files",
            )
              .remove(filePathsToDelete);
            if (delErr) {
              console.warn(
                "[upload-finalize] Failed to clean up orphaned files:",
                delErr,
              );
            } else {
              console.info(
                `[upload-finalize] Cleaned up ${filePathsToDelete.length} orphaned files for ${bookId}`,
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
  let currentDuration = 0;
  if (existingItem) {
    finalAudioFiles = existingItem.audio_files || [];
    baseIndex = finalAudioFiles.reduce(
      (max: number, af: any) => Math.max(max, af.index || 0),
      0,
    );
    currentDuration = existingItem.duration || 0;
  }

  const audioFilesJson = validFiles.map((file: any, i: number) => ({
    index: baseIndex + i + 1,
    ino: crypto.randomUUID(),
    duration: 0,
    metadata: {
      filename: file.name,
      ext: "." + (file.name.split(".").pop()?.toLowerCase() ?? ""),
      path: file.storagePath,
      relPath: file.name,
      size: file.size,
      duration: 0,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      birthtimeMs: Date.now(),
    },
    addedAt: Date.now(),
    updatedAt: Date.now(),
    mimeType: file.type || "audio/mpeg",
  }));

  finalAudioFiles = [...finalAudioFiles, ...audioFilesJson];

  // Deduplicate files by filename so re-uploading doesn't create duplicate chapters
  const uniqueFilesMap = new Map<string, any>();
  for (const af of finalAudioFiles) {
    if (af.metadata?.filename) {
      uniqueFilesMap.set(af.metadata.filename, af);
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

  if (existingItem) {
    // Update the existing record (files merged into its existing audio_files)
    const { error: bookError } = await supabase
      .from("library_items")
      .update({
        audio_files: deduplicatedFiles,
        duration: currentDuration,
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
      duration: currentDuration,
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
          name = dashSplit[0];
        }
        name = name.replace(/\b(Ph\.?D\.?|M\.?D\.?)\b/gi, "");
        name = name.replace(/([A-Za-z])\./g, "$1");
        return name.replace(/\s+/g, " ").trim();
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

  return {
    status: 200,
    json: { success: true, libraryItemId, bookId },
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
async function resolveTitleAndAuthor(
  rawTitle: string,
  rawAuthor: string,
  zaiApiKey: string,
) {
  let { cleanTitle: title, cleanAuthor: author } = parseTitleAndAuthor(
    rawTitle,
    rawAuthor,
  );

  if (
    (!author || author === "Unknown Author" || !title) && rawTitle &&
    zaiApiKey
  ) {
    try {
      const aiRes = await fetch(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${zaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "glm-4-flash",
            messages: [
              {
                role: "user",
                content:
                  `Extract the exact book title and author name from this filename/text: "${rawTitle}". Return ONLY a JSON object: {"title": "...", "author": "..."}`,
              },
            ],
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const content = aiData.choices?.[0]?.message?.content || "";
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed.title) title = parsed.title;
          if (parsed.author) author = parsed.author;
        }
      }
    } catch (e: unknown) {
      const err = e as Error;
      console.error(
        "[upload-fallback] Z.ai GLM-4 fallback error:",
        err.message,
      );
    }
  }
  return { title, author };
}

async function checkDuplicateBook(
  supabase: any,
  title: string,
  author: string,
  libraryId: string,
  zaiApiKey: string,
  bookId?: string,
) {
  let matchedId: string | null = null;

  const normalizeTitle = (s: string) => {
    if (!s) return "";
    let v = s.toLowerCase().trim();
    v = v.replace(
      /\[(audiobook|unabridged|abridged|mp3)\]|\((audiobook|unabridged|abridged|mp3)\)/gi,
      "",
    );
    v = v.replace(/\b(cd|disc|part|vol|volume)\s*\d+\b/gi, "");
    return v.replace(/[^\p{L}\p{N}]/gu, "");
  };

  // Lightweight candidate scan: only id/title/author columns (audio_files and
  // library_files JSONB columns can be huge). The full record is hydrated in a
  // second indexed query only for the single matched item.
  const LIGHT_SELECT = "id, media_id, title, author_names_first_last";
  const SCAN_LIMIT = 500;

  if (bookId) {
    const { data: itemsById } = await supabase
      .from("library_items")
      .select(LIGHT_SELECT)
      .or(`id.eq.${bookId},media_id.eq.${bookId}`)
      .eq("library_id", libraryId)
      .limit(1);

    if (itemsById && itemsById.length > 0) {
      matchedId = itemsById[0].id;
    }
  }

  if (!matchedId && title) {
    const { data: allLibItems } = await supabase
      .from("library_items")
      .select(LIGHT_SELECT)
      .eq("library_id", libraryId)
      .limit(SCAN_LIMIT);

    if (allLibItems?.length) {
      const normTitle = normalizeTitle(title);

      for (const item of allLibItems) {
        const itemTitle = (item.title || "").trim();
        if (itemTitle.toLowerCase() === title.trim().toLowerCase()) {
          matchedId = item.id;
          break;
        }
        const normItemTitle = normalizeTitle(itemTitle);
        if (normItemTitle && normItemTitle === normTitle) {
          matchedId = item.id;
          break;
        }
        if (
          normItemTitle && normTitle &&
          normItemTitle.length >= 6 && normTitle.length >= 6 &&
          (normItemTitle.startsWith(normTitle) ||
            normTitle.startsWith(normItemTitle))
        ) {
          const itemAuthor = (item.author_names_first_last || "").toLowerCase()
            .replace(/[^\p{L}\p{N}]/gu, "");
          const uploadAuthor = (author || "").toLowerCase().replace(
            /[^\p{L}\p{N}]/gu,
            "",
          );
          if (
            itemAuthor && uploadAuthor &&
            (itemAuthor === uploadAuthor ||
              itemAuthor.includes(uploadAuthor) ||
              uploadAuthor.includes(itemAuthor))
          ) {
            matchedId = item.id;
            break;
          }
        }
      }

      if (!matchedId && zaiApiKey) {
        matchedId = await matchExistingBookWithZAI(
          title,
          author,
          allLibItems,
          zaiApiKey,
        );
      }
    }
  }

  if (!matchedId) return null;

  const { data: fullItem } = await supabase
    .from("library_items")
    .select(
      "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
    )
    .eq("id", matchedId)
    .eq("library_id", libraryId)
    .limit(1)
    .maybeSingle();

  return fullItem || null;
}

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
