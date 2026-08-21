/**
 * Shared API error utilities and middleware.
 */
import { createClient } from "npm:@supabase/supabase-js@2.44.0";

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

import { Context, Next } from "hono";
import { Variables } from "./types.ts";

/**
 * Service role middleware — injects service role credentials and initialized
 * Supabase client into the Hono context for downstream handlers.
 */
export const serviceRoleMiddleware = async (
  c: Context<{ Variables: Variables }>,
  next: Next,
) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ||
    "https://placeholder.supabase.co";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") || "dummy_key";
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
