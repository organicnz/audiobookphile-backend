/**
 * Domain module index - exports all domain-driven modules.
 *
 * This module follows Domain-Driven Design (DDD) principles:
 * - Each domain module encapsulates business logic
 * - Type-safe operations with Zod validation
 * - Reusable query builders and business rules
 * - Clear separation of concerns
 */

export * from "./items.ts";
export * from "./search.ts";

/**
 * Re-export common types for convenience.
 */
export type {
  CheckExistingParams,
  CheckExistingResult,
  ItemStatus,
  MediaType,
  SearchHistoryItem,
  SearchIntent,
  SearchResultItem,
  SmartSearchParams,
  SmartSearchResult,
} from "./items.ts";

export type {} from "./search.ts";
