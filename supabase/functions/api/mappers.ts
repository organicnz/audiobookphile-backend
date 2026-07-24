import { Database } from "../../../src/types/supabase.ts";
import {
  MobileBookModel as MobileBook,
  MobileLibraryModel as MobileLibrary,
} from "../../../src/types/schemas.ts";
import { parseTitleAndAuthor } from "../_shared/titleAuthorParser.ts";

type LibraryRow = Database["public"]["Tables"]["libraries"]["Row"];
type LibraryFolderRow = Database["public"]["Tables"]["library_folders"]["Row"];
type LibraryWithFolders = LibraryRow & {
  library_folders?: LibraryFolderRow[] | null;
};

type LibraryItemRow = Database["public"]["Tables"]["library_items"]["Row"];
type BookRow = LibraryItemRow;
type MediaProgressRow = Database["public"]["Tables"]["media_progress"]["Row"];
type BookAuthorRow = Database["public"]["Tables"]["book_authors"]["Row"];
type AuthorRow = Database["public"]["Tables"]["authors"]["Row"];
type BookSeriesRow = Database["public"]["Tables"]["book_series"]["Row"];
type SeriesRow = Database["public"]["Tables"]["series"]["Row"];

type JoinedAuthor = Partial<BookAuthorRow> & { authors?: AuthorRow | null };
type JoinedSeries = Partial<BookSeriesRow> & { series?: SeriesRow | null };

export type AudioFile = {
  id?: string;
  ino?: string;
  index?: number;
  track_index?: number;
  filename?: string;
  path?: string;
  relPath?: string;
  rel_path?: string;
  storage_path?: string;
  size?: number;
  duration?: number;
  mime_type?: string;
  mimeType?: string;
  bit_rate?: number;
  bitRate?: number;
  codec?: string;
  language?: string;
  metadata?: {
    filename?: string;
    ext?: string;
    path?: string;
    relPath?: string;
    rel_path?: string;
    size?: number;
    mtimeMs?: number;
    mtime_ms?: number;
    ctimeMs?: number;
    ctime_ms?: number;
    birthtimeMs?: number;
    birthtime_ms?: number;
    duration?: number;
  };
};

export type Chapter = {
  id?: number;
  chapter_index?: number;
  title?: string;
  start_time?: number;
  start?: number;
  end_time?: number;
  end?: number;
};

// Using typed intersection for join results; only add fields actually accessed
export type LibraryItemWithBooks = LibraryItemRow & {
  book_authors?: JoinedAuthor[] | null;
  book_series?: JoinedSeries[] | null;
  folder_id?: string | null;
  added_at?: string | null;
  mtime?: string | null;
  ctime?: string | null;
  birthtime?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

function _formatCoverPath(
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
  const bookRecord = item;

  // 1. Authors & Title
  const authorsList = bookRecord.book_authors || [];
  const authors = authorsList.map((ba) => ba.authors).filter(
    Boolean,
  ) as AuthorRow[];
  const authorNames = authors.map((a) => String(a.name));
  const rawAuthorFallback = String(
    (bookRecord as any).author_names_first_last || "",
  ).trim();

  let finalTitle = String(bookRecord.title || item.title || "Unknown Title");
  let authorName = authorNames.join(", ") || rawAuthorFallback;

  if (!authorName || authorName === "Unknown Author") {
    const parsed = parseTitleAndAuthor(finalTitle);
    if (parsed.cleanAuthor && parsed.cleanAuthor !== "Unknown Author") {
      authorName = parsed.cleanAuthor;
      finalTitle = parsed.cleanTitle;
    } else {
      authorName = "Unknown Author";
    }
  }

  const authorNameLF =
    authors.map((a) => String(a.last_first || a.name)).join(", ") ||
    authorName;

  // 2. Narrators
  const narrators = bookRecord.narrators || [];
  const narratorName = Array.isArray(narrators)
    ? narrators.join(", ")
    : (narrators as string || null);

  // 3. Series
  const bookSeries = bookRecord.book_series || [];
  const seriesInfo = bookSeries[0];
  const seriesName = seriesInfo?.series ? String(seriesInfo.series.name) : null;

  // 4. Audio Files
  const audioFilesList = (bookRecord.audio_files as AudioFile[]) || [];

  const totalBookDuration =
    Number(bookRecord.duration || Number(item.duration)) || 0;
  let totalFilesSize = 0;
  const mappedFiles = audioFilesList.map((af) => {
    const meta = af.metadata || {};
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
      id: String(
        af.id || af.ino ||
          `${item.id}-track-${
            Number(
              af.track_index !== undefined
                ? af.track_index
                : (af.index !== undefined ? af.index : 0),
            )
          }`,
      ),
      ino: String(
        af.id || af.ino ||
          `${item.id}-track-${
            Number(
              af.track_index !== undefined
                ? af.track_index
                : (af.index !== undefined ? af.index : 0),
            )
          }`,
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
  const chaptersList = (bookRecord.chapters as Chapter[]) || [];
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
      id: progressRecord.id,
      libraryItemId: item.id,
      episodeId: progressRecord.episode_id || null,
      duration: Number(progressRecord.duration) ||
        Number(bookRecord.duration || Number(item.duration)) || 0,
      progress: Number(progressRecord.progress) || 0,
      currentTime: Number(progressRecord.current_time_pos) || 0,
      isFinished: progressRecord.is_finished || false,
      hideFromContinueListening: progressRecord.hide_from_continue_listening ??
        false,
      lastUpdate: new Date(
        progressRecord.last_update || Date.now(),
      ).getTime(),
      startedAt: progressRecord.started_at
        ? new Date(
          progressRecord.started_at,
        ).getTime()
        : null,
      finishedAt: progressRecord.is_finished &&
          (progressRecord.finished_at ||
            progressRecord.last_update)
        ? new Date(
          progressRecord.finished_at ||
            progressRecord.last_update!,
        ).getTime()
        : null,
    }
    : null;

  return {
    id: item.id,
    ino: item.id,
    libraryId: item.library_id,
    folderId: item.folder_id || "default",
    path: item.path || "",
    relPath: item.rel_path || item.path || "",
    isFile: item.is_file ?? false,
    mtimeMs: String(item.updated_at) || String(item.mtime)
      ? new Date(
        String(item.updated_at) || String(item.mtime),
      ).getTime()
      : Date.now(),
    ctimeMs: String(item.created_at) || String(item.ctime)
      ? new Date(
        String(item.created_at) || String(item.ctime),
      ).getTime()
      : Date.now(),
    birthtimeMs: String(item.created_at) || String(item.birthtime)
      ? new Date(
        String(item.created_at) || String(item.birthtime),
      ).getTime()
      : Date.now(),
    addedAt: String(item.added_at) || String(item.created_at)
      ? new Date(
        String(item.added_at) || String(item.created_at),
      ).getTime()
      : Date.now(),
    updatedAt: String(item.updated_at)
      ? new Date(String(item.updated_at)).getTime()
      : Date.now(),
    isMissing: item.is_missing ?? false,
    isInvalid: item.is_invalid ?? false,
    mediaType: item.media_type || "book",
    media: {
      libraryFiles: audioFiles.map((af) => ({
        id: String(af.index),
        ino: af.ino,
        metadata: af.metadata,
        isSupplementary: false,
        fileType: "audio",
      })),
      chapters: chapters,
      duration: Number(bookRecord.duration || Number(item.duration)) ||
        totalCalculatedDuration,
      size: Number(item.size) || 0,
      coverPath: _formatCoverPath(
        item.cover_path || String(bookRecord.cover_path || "") || null,
        item.id,
      ),
      tags: (bookRecord.tags as string[]) || [],
      audioFiles: audioFiles,
      tracks: audioFiles,
      numTracks: audioFiles.length,
      ebookFile: bookRecord.ebook_file
        ? (bookRecord.ebook_file as unknown as {
          ino: string;
          metadata: Record<string, unknown>;
          ebookFormat: string;
        })
        : null,
      metadata: {
        title: finalTitle,
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
