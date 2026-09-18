/**
 * Shared API error utilities and middleware.
 */

import { Context, Next } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "./types.ts";

export class ApiError extends Error {
  statusCode: number;
  code: string;
  field?: string;
  validationErrors?: unknown[];

  constructor(
    message: string,
    code: string = "INTERNAL_ERROR",
    statusCode: number = 500,
    field?: string,
    validationErrors?: unknown[],
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
    this.validationErrors = validationErrors;
  }
}

/**
 * Service role middleware — injects service role credentials and initialized
 * Supabase client into the Hono context for downstream handlers.
 * Must run BEFORE auth middleware so `c.get("supabaseUrl")` and
 * `c.get("serviceRoleKey")` are available.
 */
export const serviceRoleMiddleware = async (
  c: Context<{ Variables: Variables }>,
  next: Next,
) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ||
    "https://placeholder.supabase.co";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabase = createClient(supabaseUrl, serviceRoleKey || "anon", {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  c.set("supabaseUrl", supabaseUrl);
  c.set("serviceRoleKey", serviceRoleKey);
  c.set("supabase", supabase);
  await next();
};

/**
 * Safe error message extraction for `catch (e: unknown)` blocks.
 *
 * TypeScript best practice is `catch (e: unknown)` instead of `catch (e: any)`.
 * This utility safely extracts a human-readable message from any thrown value.
 */
export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}

/**
 * Standardized API error envelope returned by handleApiError.
 * Clients should parse `{ error: { code, message, field?, validationErrors? }, requestId, timestamp }`.
 */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    field?: string;
    validationErrors?: unknown[];
  };
  requestId: string;
  timestamp: string;
}
