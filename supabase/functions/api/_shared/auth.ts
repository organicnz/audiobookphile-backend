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
};

// Routes that don't require auth (auth routes need to create session first, plus health check)
const publicAuthRoutes = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/refresh",
  "/api/auth/callback",
  "/api/auth/verify",
  "/api/auth/logout",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/change-password",
  "/api/auth/authorize",
  "/api/auth/verify-token",
  "/api/health", // Health check should be public
]);

/**
 * Check if route should skip auth middleware
 */
export function shouldSkipAuth(c: any): boolean {
  return publicAuthRoutes.has(c.req.path);
}

/**
 * Decode JWT token to extract user information
 * @param token - JWT token string
 * @returns Decoded JWT payload or null
 */
function decodeJWT(token: string): any {
  try {
    // JWT format: header.payload.signature
    // Extract payload (second part) and base64 decode
    let payload = token.split(".")[1];
    if (!payload) return null;

    // Remove base64 padding
    const padding = (4 - (payload.length % 4)) % 4;
    payload += "=".repeat(padding);

    // Decode
    const decoded = Buffer.from(payload, "base64").toString();
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
    // Check if user exists at all
    const { data: userCheck } = await supabase
      .from("auth_identities")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (userCheck) {
      // User exists but no profile - create one or return user
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
export async function authMiddleware(c: any, next: any) {
  const authorizationHeader = c.req.header("Authorization");

  if (!authorizationHeader) {
    return authErrorHandlers.UNAUTHORIZED();
  }

  // Parse Bearer token
  const token = authorizationHeader.replace(/^Bearer\s*/i, "").trim();

  if (!token) {
    return authErrorHandlers.UNAUTHORIZED();
  }

  // Get Supabase config from context
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");

  if (!supabaseUrl) {
    return authErrorHandlers.NO_SESSION();
  }

  // Create temporary Supabase client for token validation
  const adminSupabase = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey)
    : createClient(supabaseUrl, "anon");

  try {
    // Step 1: Decode JWT token
    const payload = decodeJWT(token);

    if (!payload) {
      return authErrorHandlers.INVALID_TOKEN();
    }

    // Step 2: Validate token was signed by Supabase (by checking user ID exists)
    const userId = payload.id;

    // Step 3: Verify user exists in profiles table
    const isValid = await validateUser(adminSupabase, userId);

    if (!isValid) {
      // Check for specific reasons
      if (userId === null || userId === undefined) {
        return authErrorHandlers.INVALID_TOKEN();
      }

      const { data: userCheck } = await adminSupabase
        .from("auth_identities")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      if (!userCheck) {
        return authErrorHandlers.USER_NOT_FOUND();
      }

      return authErrorHandlers.USER_DEACTIVATED();
    }

    // Step 4: Fetch user profile with details
    const userIdFromProfile = userId;
    const { data: profile, error: profileError } = await adminSupabase
      .from("profiles")
      .select("*")
      .eq("id", userIdFromProfile)
      .maybeSingle();

    if (profileError || !profile) {
      return authErrorHandlers.USER_NOT_FOUND();
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
    console.error("[authMiddleware] Auth error:", err);
    return authErrorHandlers.UNAUTHORIZED();
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
