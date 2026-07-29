/**
 * Shared API error utilities and middleware.
 */
import { createClient } from "npm:@supabase/supabase-js@2.44.0";

export class ApiError extends Error {
  statusCode: any;
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
 * Auth error handlers — convenience factories for common auth errors.
 */
export const _authErrorHandlers = {
  UNAUTHORIZED: () => new ApiError("Unauthorized", "UNAUTHORIZED", 401),
  INVALID_TOKEN: () => new ApiError("Invalid token", "INVALID_TOKEN", 401),
  TOKEN_EXPIRED: () => new ApiError("Token expired", "TOKEN_EXPIRED", 401),
  SESSION_EXPIRED: () =>
    new ApiError("Session expired", "SESSION_EXPIRED", 401),
  NO_SESSION: () => new ApiError("No session", "NO_SESSION", 401),
  USER_NOT_FOUND: () => new ApiError("User not found", "USER_NOT_FOUND", 401),
  USER_DEACTIVATED: () =>
    new ApiError("Account deactivated", "USER_DEACTIVATED", 401),
  VALIDATION_ERROR: () =>
    new ApiError("Validation error", "VALIDATION_ERROR", 400),
};

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
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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
