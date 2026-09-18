/**
 * Shared HTTP envelope + request utilities (10x pro hardening).
 *
 * Every handler should return one of these two shapes so clients, Sentry
 * grouping, and Schemathesis contracts stay stable:
 *   - success: `c.json(payload, 200)` (payload-specific, no envelope)
 *   - error:   `{ error: { code, message, ... }, requestId, timestamp }`
 *
 * Also centralises:
 *   - request-id propagation (X-Request-ID survives the Hono response swap)
 *   - PostgREST error → ApiError mapping (no more `as any` + silent 500s)
 *   - per-query timeouts so one slow table can't hang /health or edge isolates
 */

import type { Context } from "hono";
import { ApiError } from "./errors.ts";
import type { Variables } from "./types.ts";

export type ApiContext = Context<{ Variables: Variables }>;

/** Get-or-create the request id for this request. */
export function getRequestId(c: ApiContext): string {
  const existing = c.get("requestId") as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  c.set("requestId", id);
  return id;
}

/** Standard error envelope — always includes requestId + timestamp. */
export function errorEnvelope(
  c: ApiContext,
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
) {
  return c.json(
    {
      error: { code, message, ...extra },
      requestId: getRequestId(c),
      timestamp: new Date().toISOString(),
    },
    // Hono types status codes as a union; the runtime value is authoritative.
    status as never,
  );
}

/** Map a PostgREST error to an ApiError (never leaks internals to clients). */
export function dbError(
  err:
    | { message?: string; code?: string; details?: unknown; hint?: unknown }
    | null
    | undefined,
  fallback = "Database query failed",
): ApiError {
  const message = err?.message || fallback;
  return new ApiError(message, "DATABASE_ERROR", 500);
}

/** Throw if a Supabase query errored — one-liner to kill `if (error) return c.json(...)` drift. */
export function throwIfDbError(
  error: { message?: string; code?: string } | null | undefined,
  fallback?: string,
): void {
  if (error) throw dbError(error, fallback);
}

/**
 * Race a promise against a timeout. Used for health probes and any
 * fan-out query where one slow table must not hang the whole request.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    const result = await Promise.race([promise, timeout]);
    if (result === null) {
      console.warn(`[http] timeout after ${ms}ms: ${label}`);
    }
    return result as T | null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Cache headers for immutable-ish public GETs (covers, author images). */
export function publicCacheHeaders(seconds = 3600): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${seconds}, stale-while-revalidate=86400`,
  };
}

/** No-store for private/user-specific payloads. */
export function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" };
}
