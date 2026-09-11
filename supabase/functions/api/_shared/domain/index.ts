/**
 * Domain module index — exports all domain-driven modules.
 *
 * This module follows Domain-Driven Design (DDD) principles:
 * - Each domain module encapsulates business logic
 * - Type-safe operations with Zod validation
 * - Reusable query builders and business rules
 * - Clear separation of concerns
 *
 * Domain modules are pure business logic — no HTTP, no Hono, no route concerns.
 * Routes import from here and act as thin HTTP adapters.
 */

// === Item Domain ===
export * from "./items.ts";

// === Search Domain ===
export * from "./search.ts";

// === Auth Domain ===
export * from "./auth.ts";

// === Libraries Domain ===
export * from "./libraries.ts";

// === Downloads Domain ===
export * from "./downloads.ts";

// === Playback Domain ===
export * from "./playback.ts";

/**
 * Re-export common types for convenience.
 */
export type {
  CheckExistingParams,
  CheckExistingResult,
  ItemStatus,
  MediaType,
} from "./items.ts";

export type {
  SearchHistoryItem,
  SearchIntent,
  SearchResultItem,
  SmartSearchParams,
  SmartSearchResult,
} from "./search.ts";

export type {
  LoginBody,
  PasswordStrength,
  RefreshBody,
  SignupBody,
} from "./auth.ts";

export type {
  CacheEntry,
  LibraryFolderRow,
  LibraryRow,
  LibraryWithFolders,
} from "./libraries.ts";

export type {
  NormalizedAudioFile,
  SessionManifest,
  SyncInput,
  SyncResult,
} from "./playback.ts";
