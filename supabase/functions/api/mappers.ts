import { Database } from "../../../src/types/supabase.ts";
import {
  MobileBookModel as MobileBook,
  MobileLibraryModel as MobileLibrary,
} from "../../../src/types/schemas.ts";

type LibraryRow = Database["public"]["Tables"]["libraries"]["Row"];
type LibraryFolderRow = Database["public"]["Tables"]["library_folders"]["Row"];
type LibraryWithFolders = LibraryRow & {
  library_folders?: LibraryFolderRow[] | null;
};

type LibraryItemRow = Database["public"]["Tables"]["library_items"]["Row"];
type BookRow = Database["public"]["Tables"]["books"]["Row"];
type MediaProgressRow = Database["public"]["Tables"]["media_progress"]["Row"];

// Using loose Record<string, unknown> for deep relations to avoid excessive type assertions, but strict for inputs
type LibraryItemWithBooks = LibraryItemRow & {
  books?: Record<string, unknown> | Record<string, unknown>[] | null;
};

function formatCoverPath(
  rawPath: string | null | undefined,
  itemId: string,
): string | null {
  if (!rawPath) return `/api/items/${itemId}/cover`;
  if (rawPath.startsWith("http") || rawPath.startsWith("/")) return rawPath;
  return `/api/items/${itemId}/cover`;
}

export function mapLibraryForMobile(lib: LibraryWithFolders): MobileLibrary {
  return {
    id: lib.id,
    name: lib.name || "Library",
    displayOrder: lib.display_order ?? 0,
    icon: lib.icon || "bookshelf",
    mediaType: lib.media_type || "book",
    provider: lib.provider || "local",
    settings: {
      coverAspectRatio: Number(
        (lib.settings as Record<string, unknown>)?.coverAspectRatio ??
          (lib.settings as Record<string, unknown>)?.cover_aspect_ratio ?? 1,
      ),
      disableWatcher: Boolean(
        (lib.settings as Record<string, unknown>)?.disableWatcher ??
          (lib.settings as Record<string, unknown>)?.disable_watcher ?? false,
      ),
      skipMatchingMediaWithAsin: Boolean(
        (lib.settings as Record<string, unknown>)?.skipMatchingMediaWithAsin ??
          (lib.settings as Record<string, unknown>)
            ?.skip_matching_media_with_asin ??
          false,
      ),
      skipMatchingMediaWithIsbn: Boolean(
        (lib.settings as Record<string, unknown>)?.skipMatchingMediaWithIsbn ??
          (lib.settings as Record<string, unknown>)
            ?.skip_matching_media_with_isbn ??
          false,
      ),
      autoScanCronExpression: String(
        (lib.settings as Record<string, unknown>)?.autoScanCronExpression ??
          (lib.settings as Record<string, unknown>)
            ?.auto_scan_cron_expression ??
          "",
      ) || null,
    },
    folders: lib.library_folders?.map((f: LibraryFolderRow) => ({
      id: f.id,
      fullPath: f.path || "",
      libraryId: f.library_id,
      addedAt: new Date(f.created_at || new Date().toISOString()).getTime(),
    })) || [],
    createdAt: new Date(lib.created_at).getTime(),
    updatedAt: new Date(
      lib.updated_at ||
        (lib as Record<string, unknown>).last_update as string ||
        lib.created_at,
    ).getTime(),
    lastUpdate: new Date(
      lib.updated_at ||
        (lib as Record<string, unknown>).last_update as string ||
        lib.created_at,
    ).getTime(),
  };
}

export function mapBookForMobile(
  item: LibraryItemWithBooks,
  progressRecord?: MediaProgressRow | null,
): MobileBook {
  const book = Array.isArray(item.books) ? item.books[0] : item.books;
  const bookRecord = (book as Record<string, unknown> | null) || {};

  // 1. Authors
  const authorsList = (bookRecord.book_authors as Record<string, unknown>[]) ||
    [];
  const authors = authorsList.map((ba) => ba.authors as Record<string, unknown>)
    .filter(Boolean);
  const authorNames = authors.map((a) => String(a.name));
  const authorName = authorNames.join(", ") || "Unknown Author";
  const authorNameLF =
    authors.map((a) => String(a.name_lf || a.name)).join(", ") ||
    "Unknown Author";

  // 2. Narrators
  const narrators = bookRecord.narrators || [];
  const narratorName = Array.isArray(narrators)
    ? narrators.join(", ")
    : (narrators as string || null);

  // 3. Series
  const bookSeries = (bookRecord.book_series as Record<string, unknown>[]) ||
    [];
  const seriesInfo = bookSeries[0];
  const seriesName = seriesInfo?.series
    ? String((seriesInfo.series as Record<string, unknown>).name)
    : null;

  // 4. Audio Files
  const audioFilesList =
    (bookRecord.audio_files as Record<string, unknown>[]) || [];

  const totalBookDuration =
    Number(bookRecord.duration || Number((item as any).duration)) || 0;
  let totalFilesSize = 0;
  const mappedFiles = audioFilesList.map((af) => {
    const meta = (af.metadata as Record<string, unknown>) || {};
    const size = Number(af.size || meta.size) || 0;
    totalFilesSize += size;
    return { af, meta, size };
  });
  const needsDurationEstimation = mappedFiles.some((m) =>
    (Number(m.af.duration) || Number(m.meta.duration) || 0) === 0
  );

  let totalCalculatedDuration = 0;
  const audioFiles = mappedFiles.map(({ af, meta, size }) => {
    const filename = af.filename || meta.filename || "";
    const path = af.path || meta.path || af.storage_path || "";
    const rel_path = af.relPath || af.rel_path || meta.relPath ||
      meta.rel_path || af.storage_path || af.path || "";

    let duration = Number(af.duration) || Number(meta.duration) || 0;
    if (needsDurationEstimation && duration === 0) {
      if (totalBookDuration > 0 && size > 0 && totalFilesSize > 0) {
        duration = (size / totalFilesSize) * totalBookDuration;
      } else if (totalBookDuration > 0) {
        duration = totalBookDuration / mappedFiles.length;
      } else {
        duration = size / 12000; // 96 kbps estimate
      }
    }
    totalCalculatedDuration += duration;

    return {
      ino: String(
        af.id || af.ino || `track-${Math.floor(Math.random() * 100000)}`,
      ),
      index: af.track_index !== undefined
        ? af.track_index
        : (af.index !== undefined ? af.index : 0),
      filename: filename,
      duration: duration,
      size: size,
      mimeType: af.mime_type || af.mimeType || "audio/mpeg",
      bitRate: af.bit_rate || af.bitRate || null,
      codec: af.codec || null,
      language: af.language || null,
      metadata: {
        filename: filename,
        ext: String(filename).split(".").pop() || "",
        path: path,
        relPath: rel_path,
        size: size,
        mtimeMs: Number(meta.mtimeMs || meta.mtime_ms) || new Date().getTime(),
        ctimeMs: Number(meta.ctimeMs || meta.ctime_ms) || new Date().getTime(),
        birthtimeMs: Number(meta.birthtimeMs || meta.birthtime_ms) ||
          new Date().getTime(),
      },
    };
  }).sort((a, b) => Number(a.index || 0) - Number(b.index || 0)) || [];

  // 5. Chapters
  const chaptersList = (bookRecord.chapters as Record<string, unknown>[]) || [];
  const chapters = chaptersList.map((ch) => ({
    id: ch.chapter_index !== undefined
      ? Number(ch.chapter_index)
      : (typeof ch.id === "number" ? ch.id : parseInt(String(ch.id)) || 0),
    title: String(ch.title || ""),
    start: Number(ch.start_time !== undefined ? ch.start_time : ch.start) || 0,
    end: Number(ch.end_time !== undefined ? ch.end_time : ch.end) || 0,
  })).sort((a, b) => a.id - b.id) || [];

  // 6. User Media Progress
  const userMediaProgress = progressRecord
    ? {
      id: (progressRecord as any).id,
      libraryItemId: item.id,
      episodeId: (progressRecord as any).episode_id || null,
      duration: Number((progressRecord as any).duration) ||
        Number(bookRecord.duration || Number((item as any).duration)) || 0,
      progress: Number((progressRecord as any).progress) || 0,
      currentTime: Number((progressRecord as any).current_time_pos) ||
        Number((progressRecord as any).current_time) || 0,
      isFinished: (progressRecord as any).is_finished || false,
      hideFromContinueListening:
        (progressRecord as any).hide_from_continue_listening ?? false,
      lastUpdate: new Date(
        (progressRecord as any).last_update ||
          (progressRecord as any).updated_at || Date.now(),
      ).getTime(),
      startedAt: ((progressRecord as any).started_at ||
          (progressRecord as any).created_at)
        ? new Date(
          (progressRecord as any).started_at ||
            (progressRecord as any).created_at ||
            (progressRecord as any).last_update!,
        ).getTime()
        : null,
      finishedAt: (progressRecord as any).is_finished &&
          ((progressRecord as any).finished_at ||
            (progressRecord as any).last_update)
        ? new Date(
          (progressRecord as any).finished_at ||
            (progressRecord as any).last_update!,
        ).getTime()
        : null,
    }
    : null;

  return {
    id: item.id,
    ino: item.id,
    libraryId: item.library_id,
    folderId: (item as any).folder_id || "default",
    path: item.path || "",
    relPath: item.rel_path || item.path || "",
    isFile: item.is_file ?? false,
    mtimeMs: String((item as any).updated_at) || String((item as any).mtime)
      ? new Date(
        String((item as any).updated_at) || String((item as any).mtime),
      ).getTime()
      : Date.now(),
    ctimeMs: String((item as any).created_at) || String((item as any).ctime)
      ? new Date(
        String((item as any).created_at) || String((item as any).ctime),
      ).getTime()
      : Date.now(),
    birthtimeMs:
      String((item as any).created_at) || String((item as any).birthtime)
        ? new Date(
          String((item as any).created_at) || String((item as any).birthtime),
        ).getTime()
        : Date.now(),
    addedAt: String((item as any).added_at) || String((item as any).created_at)
      ? new Date(
        String((item as any).added_at) || String((item as any).created_at),
      ).getTime()
      : Date.now(),
    updatedAt: String((item as any).updated_at)
      ? new Date(String((item as any).updated_at)).getTime()
      : Date.now(),
    isMissing: item.is_missing ?? false,
    isInvalid: item.is_invalid ?? false,
    mediaType: item.media_type || "book",
    media: {
      libraryFiles: audioFiles.map((af) => ({
        id: String((af as any).index),
        ino: af.ino,
        metadata: af.metadata as any, // TODO: Type metadata mapping
        isSupplementary: false,
        fileType: "audio",
      })),
      chapters: chapters,
      duration: Number(bookRecord.duration || Number((item as any).duration)) ||
        totalCalculatedDuration,
      size: Number(bookRecord.size || item.size) || 0,
      coverPath: item.cover_path || String(bookRecord.cover_path || "") || null,
      tags: (bookRecord.tags as string[]) || [],
      audioFiles: audioFiles as any, // TODO: Type array mapping
      tracks: audioFiles as any,
      numTracks: audioFiles.length,
      ebookFile: (bookRecord.ebook_file as any) || null,
      metadata: {
        title: String(bookRecord.title || item.title || "Unknown Title"),
        subtitle: bookRecord.subtitle ? String(bookRecord.subtitle) : null,
        authorName: authorName,
        authorNameLF: authorNameLF,
        narratorName: narratorName,
        seriesName: seriesName,
        genres: (bookRecord.genres as string[]) || [],
        publishedYear: bookRecord.published_year
          ? String(bookRecord.published_year)
          : null,
        publishedDate: bookRecord.published_date
          ? String(bookRecord.published_date)
          : null,
        publisher: bookRecord.publisher ? String(bookRecord.publisher) : null,
        description: bookRecord.description
          ? String(bookRecord.description)
          : null,
        isbn: bookRecord.isbn ? String(bookRecord.isbn) : null,
        asin: bookRecord.asin ? String(bookRecord.asin) : null,
        language: bookRecord.language ? String(bookRecord.language) : null,
        explicit: Boolean(bookRecord.explicit || false),
        abridged: Boolean(bookRecord.abridged || false),
      },
    },
    userMediaProgress: userMediaProgress,
  };
}
