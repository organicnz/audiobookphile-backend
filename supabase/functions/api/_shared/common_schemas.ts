import { z } from "zod";

// =============================================================================
// ===== COLLECTIONS & PLAYLISTS =====
// =============================================================================

/** Schema for creating a collection */
export const CollectionCreateSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  items: z.array(z.number()).optional(), // array of item IDs to add (will be assigned order)
});

/** Schema for updating a collection */
export const CollectionUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});

/** Schema for adding items to a collection */
export const CollectionItemsPayloadSchema = z.array(z.number()); // array of library item IDs

// =============================================================================
// ===== PLAYLISTS =====
// =============================================================================

/** Schema for creating a playlist */
export const PlaylistCreateSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  items: z.array(z.number()).optional(), // array of library item IDs (will be assigned order)
});

/** Schema for updating a playlist */
export const PlaylistUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});

/** Schema for adding items to a playlist */
export const PlaylistItemsPayloadSchema = z.array(z.number()); // array of library item IDs

// =============================================================================
// ===== DOWNLOADS / METADATA HANDLING =====
// =============================================================================

/** Schema for download metadata extraction */
export const DownloadMetadataSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  description: z.string().max(256).optional(),
  publisher: z.string().max(100).optional(),
  isbn: z.string().optional(),
  asin: z.string().optional(),
  language: z.enum(["en", "de", "fr", "es", "it", "pt", "nl", "da", "sv"])
    .optional(),
  explicit: z.boolean().default(false),
  abridged: z.boolean().default(false),
  durationSeconds: z.number().int().nonnegative().optional(),
});

/** Schema for downloading individual files */
export const DownloadFileSchema = z.object({
  libraryItemId: z.string().uuid("Invalid library item ID"),
  chapterIndex: z.number().optional(), // which chapter to download (0-based)
});

// =============================================================================
// ===== LIBRARIES =====
// =============================================================================

/** Schema for creating a new library */
export const LibraryCreateSchema = z.object({
  name: z.string().max(256),
  mediaType: z.string().optional(), // e.g., "books", "podcasts"
  provider: z.string().optional(), // e.g., "Kobo", "Audible"
  folders: z.array(z.object({ fullPath: z.string() })).optional(),
});

/** Schema for updating a library */
export const LibraryUpdateSchema = z.object({
  name: z.string().max(256).optional(),
  displayOrder: z.number().optional(),
  folders: z.array(
    z.object({ fullPath: z.string().optional(), id: z.string().optional() }),
  ).optional(),
});

// =============================================================================
// ===== AUTHORS =====
// =============================================================================

/** Schema for updating an author */
export const AuthorUpdateSchema = z.object({
  name: z.string().max(128).optional(),
  description: z.string().max(500).optional(),
  image_path: z.string().max(512).optional(), // path to avatar URL or file
});

// =============================================================================
// ===== BOOKMARKS =====
// =============================================================================

/** Schema for creating a bookmark */
export const BookmarkCreateSchema = z.object({
  library_item_id: z.string().uuid("Invalid library item ID"),
  time_pos: z.number().min(0).max(999999), // milliseconds into the book (up to ~12.5 hours)
  title: z.string().max(256).optional(), // optional bookmark description/title
});

/** Schema for updating a bookmark */
export const BookmarkUpdateSchema = z.object({
  time_pos: z.number().min(0).max(999999),
  title: z.string().max(256).optional(),
});

// =============================================================================
// ===== METADATA (EXTERNAL) =====
// =============================================================================

/** Schema for external metadata retrieval */
export const ExternalMetadataSchema = z.object({
  url: z.string().url("Invalid URL").min(1),
  provider: z.string().max(256).optional(), // e.g., "openlibrary", "goodreads"
});

// =============================================================================
// ===== AUTH (already defined in auth.ts, re-exporting for consistency) =====
// =============================================================================

export const LoginBodySchema = z.object({
  username: z.string().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
});

export const SignupBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  username: z.string().optional(),
});

export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const ForgotPasswordBodySchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const ResetPasswordBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  token: z.string().optional(),
  accessToken: z.string().optional(),
});

export const ChangePasswordBodySchema = z.object({
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export const AuthorizeBodySchema = z.object({
  refreshToken: z.string().optional(),
});

export const MagicLinkBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  redirectTo: z.string().optional(),
  client: z.enum(["ios", "web"]).optional(),
  server: z.string().optional(),
});

export const VerifyOtpBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().min(6, "OTP must be 6 digits"),
});
