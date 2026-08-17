import { Hono } from "hono";
import { StorageRouter } from "../../_shared/storage-router.ts";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";
import { presignUpload } from "../../_shared/uploadPresign.ts";
import { parseTitleAndAuthor } from "../../_shared/titleAuthorParser.ts";
import {
  enrichMetadataWithZAI,
  matchExistingBookWithZAI,
  sortFilesWithZAI,
} from "../../_shared/zai.ts";

function runDetached(promise: Promise<unknown>): void {
  const edgeRuntime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  })?.EdgeRuntime;
  if (
    edgeRuntime && typeof edgeRuntime.waitUntil === "function"
  ) {
    edgeRuntime.waitUntil(promise);
  } else {
    promise.catch(() => {});
  }
}

export const downloadsRouter = new Hono<{ Variables: Variables }>();

downloadsRouter.get("/:id/download", async (c) => {
  const supabase = c.get("supabase");
  const libraryItemId = c.req.param("id");

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

  return c.json(manifest);
});

downloadsRouter.get("/:id/file/:fileId/download", async (c) => {
  const supabase = c.get("supabase");
  const libraryItemId = c.req.param("id");
  const fileId = c.req.param("fileId");

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
    return c.json({ url: signedUrl });
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

async function handleUploadPresign(c: any) {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase");
  const body = await c.req.json().catch(() => ({}));
  const { filename, contentType } = body;
  if (!filename) {
    return c.json({ error: "Filename is required" }, 400);
  }
  try {
    const res = await presignUpload(supabase, filename, contentType);
    return c.json(res);
  } catch (e: any) {
    return c.json({ error: e.message || "Presign failed" }, 500);
  }
}

downloadsRouter.post("/upload-presign", handleUploadPresign);
downloadsRouter.post("/upload/presign", handleUploadPresign);

// -----------------------------------------------------------------------------
// upload-finalize: Consolidated API route (port from legacy edge function)
// -----------------------------------------------------------------------------
downloadsRouter.post("/upload/finalize", async (c) => {
  // Auth: any authenticated non-banned user (user, admin, root) — banned
  // users are rejected earlier by authMiddleware.
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Not authorized" }, 401);
  }

  const supabase = c.get("supabase");
  const storageRouter = new StorageRouter(supabase);

  const body = (await c.req.json().catch(() => ({}))) as any;
  let {
    bookId,
    title: rawTitle,
    author: rawAuthor = "",
    series = "",
    library: libraryId,
    mediaType = "book",
    files,
  } = body;

  let { cleanTitle: title, cleanAuthor: author } = parseTitleAndAuthor(
    rawTitle,
    rawAuthor,
  );

  const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
    Deno.env.get("ZHIPU_API_KEY") ?? "";

  // AI title/author extraction fallback via Z.ai GLM-4 when author is unknown
  // or the title is ambiguous
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
        "[upload-finalize] Z.ai GLM-4 fallback error:",
        err.message,
      );
    }
  }

  if (!bookId || !title || !libraryId || !files?.length) {
    return c.json({ error: "Missing fields" }, 400);
  }

  // --- Check for missing files in storage ---
  const missingFiles: string[] = [];
  const fileCheckPromises = files.map(async (file: any) => {
    const exists = await storageRouter.fileExists(file.storagePath);
    return exists ? null : file.storagePath;
  });

  const checkResults = await Promise.all(fileCheckPromises);
  missingFiles.push(...checkResults.filter((r): r is string => r !== null));

  if (missingFiles.length > 0) {
    return c.json(
      { error: "Files missing in storage", missingFiles },
      400,
    );
  }

  const totalSize = files.reduce((sum: number, f: any) => sum + f.size, 0);

  // --- SMART REBINDING & DUPLICATE PREVENTION ---
  let existingItem: any = null;

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

  // 1. Try matching directly by bookId or media_id
  const { data: itemsById } = await supabase
    .from("library_items")
    .select(
      "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
    )
    .or(`id.eq.${bookId},media_id.eq.${bookId}`)
    .eq("library_id", libraryId)
    .limit(1);

  if (itemsById && itemsById.length > 0) {
    existingItem = itemsById[0];
  } else if (title) {
    // Fetch all items in library for exact, normalized, and Z.AI matching
    const { data: allLibItems } = await supabase
      .from("library_items")
      .select(
        "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
      )
      .eq("library_id", libraryId);

    if (allLibItems?.length) {
      const normTitle = normalizeTitle(title);

      // 2. Try exact title, normalized fuzzy title match, or prefix title + matching author
      for (const item of allLibItems) {
        const itemTitle = (item.title || "").trim();
        if (itemTitle.toLowerCase() === title.trim().toLowerCase()) {
          existingItem = item;
          break;
        }
        const normItemTitle = normalizeTitle(itemTitle);
        if (normItemTitle && normItemTitle === normTitle) {
          existingItem = item;
          break;
        }
        if (
          normItemTitle && normTitle &&
          (normItemTitle.startsWith(normTitle) ||
            normTitle.startsWith(normItemTitle))
        ) {
          const itemAuthor = (item.author_names_first_last || "")
            .toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
          const uploadAuthor = (author || "").toLowerCase().replace(
            /[^\p{L}\p{N}]/gu,
            "",
          );
          if (
            !itemAuthor || !uploadAuthor ||
            itemAuthor.includes(uploadAuthor) ||
            uploadAuthor.includes(itemAuthor)
          ) {
            existingItem = item;
            break;
          }
        }
      }

      // 3. Try Z.AI AI Semantic/Fuzzy Match if normalized match didn't find item
      if (!existingItem && zaiApiKey) {
        const matchedId = await matchExistingBookWithZAI(
          title,
          author,
          allLibItems,
          zaiApiKey,
        );
        if (matchedId) {
          existingItem = allLibItems.find((i) => i.id === matchedId) || null;
        }
      }
    }
  }

  let libraryItemId = crypto.randomUUID();
  if (existingItem) {
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

  const audioFilesJson = files.map((file: any, i: number) => ({
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

  // --- Z.AI AI-OPTIMIZED SEQUENCE SORTING ---
  const filenames = deduplicatedFiles.map((af: any) =>
    af.metadata?.filename || af.metadata?.relPath || ""
  ).filter(Boolean);

  if (filenames.length > 1) {
    const sortedFilenames = await sortFilesWithZAI(filenames, zaiApiKey);
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

  const { error: bookError } = await supabase
    .from("library_items")
    .update({
      audio_files: deduplicatedFiles,
      duration: currentDuration,
      title: title || existingItem?.title,
    })
    .eq("id", libraryItemId);

  if (bookError && !existingItem) {
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
    if (res.error) throw res.error;
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

  if (itemError && !existingItem) {
    throw itemError;
  }

  // --- BACKGROUND TASK: Extract Audio Duration ---
  const processDurationsAsync = async () => {
    try {
      let mm: any = null;
      try {
        mm = await import("music-metadata");
      } catch (_err) {
        console.warn("[upload-finalize] Could not load music-metadata");
      }

      const metadataPromises = files.map(async (file: any, i: number) => {
        const existingAf = audioFilesJson[i];
        let duration = 0;
        try {
          const signedUrl = await storageRouter.getSignedUrl(
            file.storagePath,
            60,
          );
          if (signedUrl && mm) {
            const res = await fetch(signedUrl);
            if (res.body) {
              const metadata = await mm.parseWebStream(
                res.body,
                { mimeType: file.type, size: file.size },
                { duration: true, skipCovers: true, skipPostHeaders: true },
              );
              duration = metadata.format?.duration || 0;

              try {
                res.body.cancel();
              } catch (_e) {
                // Ignore
              }
            }
          }
        } catch (err) {
          console.warn(
            `[upload-finalize] Background duration parse failed for ${file.name}:`,
            err,
          );
        }

        return {
          ...existingAf,
          duration,
          metadata: {
            ...existingAf.metadata,
            duration,
          },
        };
      });

      const updatedAudioFilesJson = await Promise.all(metadataPromises);

      // Fetch latest state of book to merge updated durations
      const { data: latestBook } = await supabase
        .from("library_items")
        .select("audio_files")
        .eq("id", libraryItemId)
        .maybeSingle();
      const existingAudioFiles: any[] = (latestBook?.audio_files as any[]) ||
        deduplicatedFiles;

      const updatedMap = new Map<string, any>();
      for (const af of existingAudioFiles) {
        if (af.metadata?.filename) updatedMap.set(af.metadata.filename, af);
      }
      for (const updatedAf of updatedAudioFilesJson) {
        if (updatedAf.metadata?.filename) {
          updatedMap.set(updatedAf.metadata.filename, updatedAf);
        }
      }

      const finalMergedAudioFiles = Array.from(updatedMap.values());
      finalMergedAudioFiles.forEach((af, idx) => (af.index = idx + 1));

      const totalDuration = finalMergedAudioFiles.reduce(
        (sum: number, af: any) => sum + (af.duration || 0),
        0,
      );

      await supabase
        .from("library_items")
        .update({
          audio_files: finalMergedAudioFiles,
          duration: totalDuration,
        })
        .eq("id", libraryItemId);

      console.info(
        `[upload-finalize] Successfully updated duration for book ${libraryItemId} to ${totalDuration}s`,
      );
    } catch (err) {
      console.error(
        `[upload-finalize] Background duration extraction failed for book ${libraryItemId}:`,
        err,
      );
    }
  };

  runDetached(processDurationsAsync());

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

  // --- Z.AI AUTOMATED METADATA ENRICHMENT (detached, cache-gated) ---
  if (title && zaiApiKey) {
    runDetached(
      (async () => {
        try {
          const enriched = await enrichMetadataWithZAI(
            title,
            author,
            zaiApiKey,
          );
          if (enriched) {
            await supabase
              .from("library_items")
              .update({
                description: enriched.description || undefined,
                genres: enriched.genres || undefined,
                published_year: enriched.publishedYear || undefined,
              })
              .eq("id", libraryItemId);
            console.info(
              `[upload-finalize] Z.AI successfully enriched metadata for "${title}"`,
            );
          }
        } catch (_err) {
          // Silent enrichment fallback
        }
      })(),
    );
  }

  return c.json({ success: true, libraryItemId, bookId });
});
