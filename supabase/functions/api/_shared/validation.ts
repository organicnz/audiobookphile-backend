/**
 * Shared validation utilities for input sanitization and length constraints.
 *
 * This module provides reusable Zod schemas and validation helpers to enforce
 * input length constraints and prevent security vulnerabilities like XSS.
 */

import { z } from "zod";

/**
 * Maximum lengths for common fields.
 * These prevent memory exhaustion attacks and ensure database constraints are met.
 */
export const MAX_LENGTHS = {
  TITLE: 256,
  AUTHOR: 300,
  DESCRIPTION: 4096,
  USERNAME: 64,
  EMAIL: 320, // RFC 5321 max
  PASSWORD: 128,
  SEARCH_QUERY: 256,
  URL: 2048,
  PATH: 512,
} as const;

/**
 * Sanitize a string by trimming whitespace and removing control characters.
 * This prevents XSS attacks from user input.
 */
export function sanitizeString(input: string): string {
  return input
    .trim()
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
    .replace(/\s+/g, " "); // Normalize whitespace
}

/**
 * Create a sanitized string schema with max length validation.
 */
export function sanitizedString(maxLength: number, minLength = 1): z.ZodString {
  return z
    .string()
    .min(minLength)
    .max(maxLength)
    .transform((val) => sanitizeString(val));
}

/**
 * Common validation schemas for reuse across routes.
 */
export const CommonSchemas = {
  // Auth
  username: sanitizedString(MAX_LENGTHS.USERNAME)
    .regex(
      /^[\w-]+$/,
      "Username can only contain letters, numbers, hyphens, and underscores",
    ),

  email: z.string().email().max(MAX_LENGTHS.EMAIL).transform(sanitizeString),

  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(MAX_LENGTHS.PASSWORD)
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),

  // Content
  title: sanitizedString(MAX_LENGTHS.TITLE),

  author: sanitizedString(MAX_LENGTHS.AUTHOR),

  description: sanitizedString(MAX_LENGTHS.DESCRIPTION).optional(),

  // Search
  searchQuery: sanitizedString(MAX_LENGTHS.SEARCH_QUERY),

  // IDs
  uuid: z.string().uuid("Invalid ID format"),

  libraryId: z.string().min(1, "Library ID is required"),

  // Pagination
  limit: z.coerce.number().int().min(1).max(100).default(20),

  offset: z.coerce.number().int().min(0).default(0),

  // URLs
  url: z.string().url().max(MAX_LENGTHS.URL),
} as const;

/**
 * Pagination schema for list endpoints.
 */
export const PaginationSchema = z.object({
  limit: CommonSchemas.limit,
  offset: CommonSchemas.offset,
});

/**
 * Validate and parse input with detailed error messages.
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context = "input",
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.errors.map((err) => ({
      field: err.path.join(".") || context,
      message: err.message,
      code: err.code,
    }));
    throw new Error(
      `Validation failed for ${context}: ${JSON.stringify(errors)}`,
    );
  }
  return result.data;
}

/**
 * Extract validation errors from a Zod error.
 */
export function extractValidationErrors(
  error: z.ZodError,
): Array<{ field: string; message: string }> {
  return error.errors.map((err) => ({
    field: err.path.join("."),
    message: err.message,
  }));
}
