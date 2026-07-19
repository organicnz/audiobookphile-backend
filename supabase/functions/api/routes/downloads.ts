import { Hono } from "hono";
import { StorageRouter } from "../../_shared/storage-router.ts";
import { Variables } from "../_shared/types.ts";

export const downloadsRouter = new Hono<{ Variables: Variables }>();

downloadsRouter.get("/:id/download", async (c) => {
  const supabase = c.get("supabase");
  const libraryItemId = c.req.param("id");

  // Fetch the item and its audio files
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
        )
      )
    `)
    .eq("id", libraryItemId)
    .maybeSingle();

  if (itemError || !item) {
    return c.json(
      { error: `Library item not found: ${itemError?.message || ""}` },
      404,
    );
  }

  const book = Array.isArray(item.books) ? item.books[0] : item.books;

  const audioFilesList =
    ((book as Record<string, unknown>)?.audio_files || []) as Record<
      string,
      unknown
    >[];

  if (!audioFilesList.length) {
    return c.json({ error: "No audio files found for this item" }, 404);
  }

  const totalBookDuration = Number((book as any)?.duration) || 0;

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
      metadata.path ?? (af as any).storage_path ?? (af as any).path ?? "",
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
    return c.json(
      { error: "All audio files are missing from storage. Cannot download." },
      404,
    );
  }

  // Get Authors
  const bookAuthors = (book?.book_authors as Record<string, unknown>[]) || [];
  const authors = bookAuthors.map((ba) => ba.authors as Record<string, unknown>)
    .filter(Boolean);
  const authorNames = authors.map((a) => String(a.name));
  const authorName = authorNames.join(", ") || "Unknown Author";

  const manifest = {
    libraryItemId,
    title: String(book?.title || item.title || "Unknown Title"),
    author: authorName,
    duration: totalBookDuration ||
      tracks.reduce((acc, t) => acc + t.duration, 0),
    totalSize: totalFilesSize,
    tracks: tracks,
  };

  return c.json(manifest);
});
