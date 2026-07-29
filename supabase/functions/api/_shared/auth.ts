/**
 * Auth Middleware
 *
 * Centralized authentication middleware that:
 * - Extracts JWT token from Authorization header
 * - Validates the token against Supabase profiles table
 * - Returns appropriate 401 errors for failure cases
 * - Skips auth for /api/auth/* routes (they create session first)
 * - Sets user in context for downstream routes
 *
 * IMPORTANT: Does NOT require a session to exist - validates JWT directly
 * This solves the chicken-egg problem for auth routes.
 */
import { ApiError } from "./errors.ts";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Context, Next } from "hono";
import { Variables } from "./types.ts";

// Auth errors - centralize all auth-related errors
export const authErrorHandlers = {
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

// Routes that don't require auth (auth routes need to create session first, plus health check)
const publicAuthRoutes = new Set([
  "/api/auth/login",
  "/api/login",
  "/api/auth/refresh",
  "/api/refresh",
  "/api/auth/callback",
  "/api/callback",
  "/api/auth/verify",
  "/api/verify",
  "/api/auth/logout",
  "/api/logout",
  "/api/auth/forgot-password",
  "/api/forgot-password",
  "/api/auth/reset-password",
  "/api/reset-password",
  "/api/auth/change-password",
  "/api/change-password",
  "/api/auth/authorize",
  "/api/authorize",
  "/api/auth/verify-token",
  "/api/verify-token",
  "/api/auth/magic-link",
  "/api/magic-link",
  "/api/auth/signup",
  "/api/signup",
  "/api/auth/2fa/verify-login",
  "/api/2fa/verify-login",
  "/api/health", // Health check should be public
]);

/**
 * Check if route should skip auth middleware
 */
export function shouldSkipAuth(c: Context<{ Variables: Variables }>): boolean {
  if (publicAuthRoutes.has(c.req.path)) {
    return true;
  }

  // Skip auth for GET cover images and author images (fetched by <img> / AsyncImage in iOS/Web without Authorization headers)
  if (c.req.method === "GET") {
    if (c.req.path.startsWith("/api/items/") && c.req.path.endsWith("/cover")) {
      return true;
    }
    if (
      c.req.path.startsWith("/api/authors/") && c.req.path.endsWith("/image")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Decode JWT token to extract user information
 * @param token - JWT token string
 * @returns Decoded JWT payload or null
 */
export function decodeJWT(token: string): any {
  try {
    // JWT format: header.payload.signature
    // Extract payload (second part) and base64url decode
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return null;

    // Convert base64url → standard base64, then decode with Deno-native atob()
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64);
    return JSON.parse(decoded);
  } catch (e) {
    console.error("[authMiddleware] JWT decode error:", e);
    return null;
  }
}

/**
 * Validate JWT token by checking if user exists and is active
 * @param supabase - Supabase client
 * @param userId - User ID from JWT token
 * @returns Promise<boolean>
 */
async function validateUser(supabase: any, userId: string): Promise<boolean> {
  // Fetch the user from Supabase profiles table
  const { data: profile, error: fetchError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (fetchError) {
    // Profile not found — check if the auth user exists via admin API
    // (auth schema tables like auth.identities are not accessible from public schema)
    const { data: userData } = await supabase.auth.admin.getUserById(userId);

    if (userData?.user) {
      // User exists in auth but no profile yet — allow through
      return true;
    }

    return false;
  }

  // Check if user is deactivated/banned
  if (profile.user_type === "banned" || profile.is_banned === true) {
    return false;
  }

  // Check if profile is locked
  if (profile.is_locked === true) {
    return false;
  }

  return true;
}

/**
 * Auth Middleware
 */
export async function authMiddleware(
  c: Context<{ Variables: Variables }>,
  next: Next,
) {
  // Skip auth for public routes (login, signup, refresh, etc.)
  if (shouldSkipAuth(c)) {
    return next();
  }

  const authorizationHeader = c.req.header("Authorization");
  let token = "";

  if (authorizationHeader) {
    token = authorizationHeader.replace(/^Bearer\s*/i, "").trim();
  } else if (c.req.query("token")) {
    token = c.req.query("token")!.trim();
  }

  if (!token) {
    throw authErrorHandlers.UNAUTHORIZED();
  }

  // Get Supabase config from context
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");

  if (!supabaseUrl) {
    throw authErrorHandlers.NO_SESSION();
  }

  // Create temporary Supabase client for token validation
  const adminSupabase = createClient(
    supabaseUrl,
    serviceRoleKey || "anon",
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  try {
    // Step 1: Decode JWT token
    const payload = decodeJWT(token);

    if (!payload) {
      throw authErrorHandlers.INVALID_TOKEN();
    }

    // Step 2: Extract user ID from Supabase JWT (uses 'sub' claim per OIDC spec)
    const userId = payload.sub;

    // Step 3: Verify user exists in profiles table
    const isValid = await validateUser(adminSupabase, userId);

    if (!isValid) {
      // Check for specific reasons
      if (userId === null || userId === undefined) {
        throw authErrorHandlers.INVALID_TOKEN();
      }

      // Check if user exists via admin API (auth schema tables are not
      // accessible from the public schema)
      const { data: userData } = await adminSupabase.auth.admin.getUserById(
        userId,
      );

      if (!userData?.user) {
        throw authErrorHandlers.USER_NOT_FOUND();
      }

      throw authErrorHandlers.USER_DEACTIVATED();
    }

    // Step 4: Fetch user profile with details
    const userIdFromProfile = userId;
    const { data: profile, error: profileError } = await adminSupabase
      .from("profiles")
      .select("*")
      .eq("id", userIdFromProfile)
      .maybeSingle();

    if (profileError || !profile) {
      throw authErrorHandlers.USER_NOT_FOUND();
    }

    // Step 5: Set user in context
    c.set("user", {
      id: userId,
      username: profile.username,
      email: payload.email || null,
      type: profile.user_type,
      permissions: {
        download: true,
        update: profile.user_type === "admin",
        delete: profile.user_type === "admin",
        upload: profile.user_type === "admin",
        accessAllLibraries: profile.user_type === "admin",
        accessAllTags: profile.user_type === "admin",
        accessExplicitContent: profile.user_type === "admin",
      },
      librariesAccessible: [],
      itemTagsAccessible: [],
      created_at: profile.created_at,
      last_sign_in_at: profile.updated_at || profile.created_at,
    });

    c.set("userId", userId);
    c.set("userEmail", payload.email || null);
    c.set("sessionId", userId); // Using userId as session ID for now
    c.set("token", token);

    // Mark route as requiring service role if needed
    // This should be set by individual routes that need admin access
    c.set("requiresServiceRole", false);

    // Fetch user's default library
    const { data: defaultLibrary } = await adminSupabase
      .from("profiles")
      .select("default_library_id")
      .eq("id", userId)
      .maybeSingle();

    c.set("userDefaultLibraryId", defaultLibrary?.default_library_id || null);
  } catch (err) {
    // Re-throw ApiErrors so the error-handling middleware serialises them
    if (err instanceof ApiError) throw err;
    console.error("[authMiddleware] Auth error:", err);
    throw authErrorHandlers.UNAUTHORIZED();
  }

  await next();
}

/**
 * Check if a user profile is banned or inactive
 */
export async function checkUserStatus(
  adminSupabase: any,
  userId: string,
): Promise<boolean> {
  const { data: profile } = await adminSupabase
    .from("profiles")
    .select("is_banned, is_locked, user_type")
    .eq("id", userId)
    .maybeSingle();

  if (!profile) {
    return true;
  }

  // User is banned
  if (profile.is_banned === true || profile.user_type === "banned") {
    return false;
  }

  return true;
}
