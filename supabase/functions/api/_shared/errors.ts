/**
 * Shared API error utilities and middleware.
 */

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

/**
 * Service role middleware — injects service role credentials
 * from Deno env into the Hono context for downstream handlers.
 */
export const serviceRoleMiddleware = async (
  c: any,
  next: () => Promise<void>,
) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  c.set("supabaseUrl", supabaseUrl);
  c.set("serviceRoleKey", serviceRoleKey);
  await next();
};
