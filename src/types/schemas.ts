/**
 * ⚠️  SOURCE OF TRUTH
 *
 * This file is the canonical definition of all Zod schemas shared between
 * the backend edge functions and the web application.
 *
 * The web application keeps a copy at:
 *   audiobookphile-web/src/types/schemas.ts
 *
 * After editing this file:
 *   1. Run `pnpm generate-types` (or `npm run generate-types`) in the backend
 *      workspace to regenerate supabase.ts from the live database.
 *   2. Copy this file to the web location above.
 *   3. Commit both changes together so the copies stay in sync.
 */
import { z } from "zod";

export const AudioMetadataSchema = z.object({
  filename: z.string().nullish(),
  ext: z.string().nullish(),
  path: z.string().nullish(),
  relPath: z.string().nullish(),
  size: z.number().nullish(),
  mtimeMs: z.number().nullish(),
  ctimeMs: z.number().nullish(),
  birthtimeMs: z.number().nullish(),
  duration: z.number().nullish(),
});

export const AudioFileSchema = z.object({
  id: z.string(),
  index: z.number(),
  ino: z.string(),
  metadata: AudioMetadataSchema,
  duration: z.number(),
  bitRate: z.number().nullish(),
  language: z.string().nullish(),
  codec: z.string().nullish(),
  mimeType: z.string(),
  addedAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
});

export const ChapterSchema = z.object({
  id: z.number(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
});

export const FileMetadataSchema = z.object({
  filename: z.string().nullish(),
  ext: z.string().nullish(),
  path: z.string().nullish(),
  relPath: z.string().nullish(),
  size: z.number().nullish(),
  mtimeMs: z.number().nullish(),
  ctimeMs: z.number().nullish(),
  birthtimeMs: z.number().nullish(),
});

export const LibraryFileSchema = z.object({
  id: z.string(),
  ino: z.string(),
  metadata: FileMetadataSchema.nullish(),
  isSupplementary: z.boolean().nullish(),
  fileType: z.string().nullish(),
  addedAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
});

export const EbookFileSchema = z.object({
  ino: z.string(),
  metadata: FileMetadataSchema,
  ebookFormat: z.string(),
});

/**
 * BookMetadataSchema — flat string representation of book metadata.
 * Authors, narrators, and series are pre-joined as strings, not arrays.
 * This is the shape the iOS / mobile client expects.
 *
 * Compare with `BookMetadata` in the web `api/models.ts`, which uses
 * structured Author[], string[], Series[] for the ABS / web path.
 *
 * `BookMetadataModel` below is pinned to `BookMetadataFlat` (the interface
 * declared in the web layer) so any drift between them is caught at compile time.
 */
export const BookMetadataSchema = z.object({
  title: z.string(),
  subtitle: z.string().nullish(),
  authorName: z.string().nullish(),
  authorNameLF: z.string().nullish(),
  narratorName: z.string().nullish(),
  seriesName: z.string().nullish(),
  genres: z.array(z.string()),
  publishedYear: z.string().nullish(),
  publishedDate: z.string().nullish(),
  publisher: z.string().nullish(),
  description: z.string().nullish(),
  isbn: z.string().nullish(),
  asin: z.string().nullish(),
  language: z.string().nullish(),
  explicit: z.boolean(),
  abridged: z.boolean().nullish(),
});

export const BookMediaSchema = z.object({
  libraryFiles: z.array(LibraryFileSchema).nullish(),
  chapters: z.array(ChapterSchema).nullish(),
  duration: z.number().nullish(),
  size: z.number().nullish(),
  metadata: BookMetadataSchema,
  coverPath: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  audioFiles: z.array(AudioFileSchema).nullish(),
  tracks: z.array(AudioFileSchema).nullish(),
  numTracks: z.number().optional(),
  ebookFile: EbookFileSchema.nullish(),
});

export const MediaProgressSchema = z.object({
  id: z.string(),
  libraryItemId: z.string(),
  episodeId: z.string().nullish(),
  duration: z.number(),
  progress: z.number(),
  currentTime: z.number(),
  isFinished: z.boolean(),
  hideFromContinueListening: z.boolean().nullish(),
  lastUpdate: z.number(),
  startedAt: z.number().nullish(),
  finishedAt: z.number().nullish(),
});

export const MobileBookSchema = z.object({
  id: z.string(),
  ino: z.string().optional(),
  libraryId: z.string().nullish(),
  folderId: z.string().nullish(),
  path: z.string().nullish(),
  relPath: z.string().nullish(),
  isFile: z.boolean().optional(),
  mtimeMs: z.number().optional(),
  ctimeMs: z.number().optional(),
  birthtimeMs: z.number().optional(),
  addedAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
  isMissing: z.boolean().nullish(),
  isInvalid: z.boolean().optional(),
  mediaType: z.string().optional(),
  libraryFiles: z.array(LibraryFileSchema).nullish(),
  media: BookMediaSchema,
  userMediaProgress: MediaProgressSchema.nullish(),
});

export const LibraryFolderSchema = z.object({
  id: z.string(),
  fullPath: z.string().nullish(),
  libraryId: z.string().nullish(),
  addedAt: z.number().nullish(),
});

export const LibrarySettingsSchema = z.object({
  coverAspectRatio: z.number().nullish(),
  disableWatcher: z.boolean().nullish(),
  skipMatchingMediaWithAsin: z.boolean().nullish(),
  skipMatchingMediaWithIsbn: z.boolean().nullish(),
  autoScanCronExpression: z.string().nullish(),
});

export const MobileLibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  folders: z.array(LibraryFolderSchema).nullish(),
  displayOrder: z.number().nullish(),
  icon: z.string().nullish(),
  mediaType: z.string().nullish(),
  provider: z.string().nullish(),
  settings: LibrarySettingsSchema.nullish(),
  createdAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
  lastUpdate: z.number().nullish(),
});

export type AudioMetadataModel = z.infer<typeof AudioMetadataSchema>;
export type AudioFileModel = z.infer<typeof AudioFileSchema>;
export type ChapterModel = z.infer<typeof ChapterSchema>;
export type FileMetadataModel = z.infer<typeof FileMetadataSchema>;
export type LibraryFileModel = z.infer<typeof LibraryFileSchema>;
export type EbookFileModel = z.infer<typeof EbookFileSchema>;
/**
 * BookMetadataModel is the inferred type from BookMetadataSchema.
 *
 * In the web layer (audiobookphile-web/src/types/schemas.ts) this type is
 * additionally pinned to `BookMetadataFlat` from `@/types/api/models` so
 * that drift between the schema and the interface is caught at compile time.
 * When making structural changes here, verify the web copy still compiles.
 */
export type BookMetadataModel = z.infer<typeof BookMetadataSchema>;
export type BookMediaModel = z.infer<typeof BookMediaSchema>;
export type MediaProgressModel = z.infer<typeof MediaProgressSchema>;
export type MobileBookModel = z.infer<typeof MobileBookSchema>;
export type LibraryFolderModel = z.infer<typeof LibraryFolderSchema>;
export type LibrarySettingsModel = z.infer<typeof LibrarySettingsSchema>;
export type MobileLibraryModel = z.infer<typeof MobileLibrarySchema>;
