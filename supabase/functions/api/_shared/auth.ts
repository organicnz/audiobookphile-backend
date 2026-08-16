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
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Context, Next } from "hono";
import { Variables } from "./types.ts";

export const isRole = (
  role: string | undefined | null,
  allowed: string[],
): boolean => role !== null && role !== undefined && allowed.includes(role);

/**
 * Admin-role check. Both "admin" and "root" are privileged roles. `c.get("user")`
 * is populated by authMiddleware from the profiles table on every request, so this
 * check is always DB-fresh and never relies on JWT claims.
 */
export const ADMIN_ROLES = ["admin", "root"] as const;

export function requireAdminRole(
  user: { type?: string } | undefined | null,
): boolean {
  return !!user &&
    ADMIN_ROLES.includes(user.type as (typeof ADMIN_ROLES)[number]);
}

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
  "/api/auth/2fa/webauthn/login/options",
  "/api/2fa/webauthn/login/options",
  "/api/auth/2fa/webauthn/login/verify",
  "/api/2fa/webauthn/login/verify",
  "/api/health", // Health check should be public
]);

/**
 * Check if route should skip auth middleware
 */
export function shouldSkipAuth(c: Context<{ Variables: Variables }>): boolean {
  const path = c.req.path.replace(/\/+$/, "") || "/";
  if (publicAuthRoutes.has(path)) {
    return true;
  }

  const withApi = path.startsWith("/api") ? path : "/api" + path;
  const withoutApi = path.startsWith("/api")
    ? path.replace(/^\/api/, "") || "/"
    : path;
  if (publicAuthRoutes.has(withApi) || publicAuthRoutes.has(withoutApi)) {
    return true;
  }

  // Skip auth for GET cover images and author images (fetched by <img> / AsyncImage in iOS/Web without Authorization headers)
  if (c.req.method === "GET") {
    if (
      (withApi.startsWith("/api/items/") || withoutApi.startsWith("/items/")) &&
      withApi.endsWith("/cover")
    ) {
      return true;
    }
    if (
      (withApi.startsWith("/api/authors/") ||
        withoutApi.startsWith("/authors/")) &&
      withApi.endsWith("/image")
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
 *
 * WARNING: decode-only. Performs NO signature verification — never use
 * for authorization decisions. Use verifyJWT() instead.
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
 * GoTrue publishes the current access-token signing keys (ECDSA ES256) at
 * this endpoint. Fetched lazily by jose on first verify and cached; key
 * rotation is handled automatically via the `kid` header of each token.
 * Resolved lazily so module import works in sandboxes without env access
 * (e.g. `deno test` without --allow-env).
 */
let remoteJWKSet: ReturnType<typeof createRemoteJWKSet> | null = null;

function getRemoteJWKSet() {
  if (!remoteJWKSet) {
    const base = Deno.env.get("SUPABASE_URL") ||
      "https://placeholder.supabase.co";
    remoteJWKSet = createRemoteJWKSet(
      new URL(`${base}/auth/v1/.well-known/jwks.json`),
    );
  }
  return remoteJWKSet;
}

/**
 * Cryptographically verify a JWT and return the verified payload, or null
 * when the signature is invalid/tampered.
 *
 * GoTrue signs access tokens with ES256 (ECDSA) using a per-project key
 * published at the JWKS endpoint. Legacy tokens (and any HS256-signed
 * tokens) are verified against the project's SUPABASE_JWT_SECRET. Every
 * authorization decision in the API must use the verified payload returned
 * by this function — never decodeJWT().
 */
export async function verifyJWT(token: string): Promise<any | null> {
  let secret: string | undefined;
  try {
    secret = Deno.env.get("SUPABASE_JWT_SECRET");
  } catch {
    secret = undefined;
  }

  try {
    const { payload } = await jwtVerify(token, getRemoteJWKSet());
    return payload;
  } catch (jwksErr) {
    // Fall back to HS256 verification for legacy/symmetric-signed tokens.
    if (!secret) {
      console.error(
        "[verifyJWT] JWKS verification failed:",
        (jwksErr as Error)?.message,
      );
      return null;
    }
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
        {
          algorithms: ["HS256"],
        },
      );
      return payload;
    } catch (hs256Err) {
      console.error(
        "[verifyJWT] Signature verification failed:",
        (hs256Err as Error)?.message,
        "| JWKS error:",
        (jwksErr as Error)?.message,
      );
      return null;
    }
  }
}

/**
 * Load the profile row needed for authorization in a single query.
 * Validation (banned/locked), the profile for the request context, and the
 * default library id are all derived from one select — previously this was
 * three sequential round trips (validateUser + profile + default_library),
 * tripling per-request database latency.
 */
const PROFILE_SELECT =
  "id, username, user_type, is_banned, is_locked, default_library_id, created_at, updated_at";

async function loadProfileForAuth(adminSupabase: any, userId: string) {
  const { data: profile, error: profileError } = await adminSupabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("id", userId)
    .maybeSingle();

  if (profileError || !profile) {
    // Profile not found — check if the auth user exists via admin API
    // (auth schema tables like auth.identities are not accessible from public
    // schema), then auto-create the profile row.
    const { data: userData } = await adminSupabase.auth.admin.getUserById(
      userId,
    );
    if (!userData?.user) return null;
    const defaultUsername = userData.user.email?.split("@")[0] || "User";
    const { data: created, error: insertError } = await adminSupabase
      .from("profiles")
      .insert({
        id: userId,
        username: defaultUsername,
        user_type: "user",
      })
      .select(PROFILE_SELECT)
      .single();
    if (insertError || !created) return null;
    return created;
  }
  return profile;
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

  // Cron/service-role bypass: legacy standalone functions authenticated
  // scheduled jobs by literal comparison of the Authorization header against
  // CRON_SECRET or SUPABASE_SERVICE_ROLE_KEY. Supabase service keys are
  // HS256 JWTs that verifyJWT() cannot validate (the project has no
  // SUPABASE_JWT_SECRET for the symmetric fallback), so preserve the legacy
  // scheme for cron-driven endpoints like the automated database backup.
  if (authorizationHeader) {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const serviceRoleKeyEnv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (
      (typeof cronSecret === "string" && cronSecret.length > 0 &&
        authorizationHeader === `Bearer ${cronSecret}`) ||
      (typeof serviceRoleKeyEnv === "string" && serviceRoleKeyEnv.length > 0 &&
        authorizationHeader === `Bearer ${serviceRoleKeyEnv}`)
    ) {
      c.set("user", {
        id: "cron",
        username: "cron",
        email: null,
        type: "root",
        permissions: {
          download: true,
          update: true,
          delete: true,
          upload: true,
          accessAllLibraries: true,
          accessAllTags: true,
          accessExplicitContent: true,
        },
        librariesAccessible: [],
        itemTagsAccessible: [],
      });
      c.set("userId", "cron");
      c.set("userEmail", null);
      c.set("sessionId", "cron");
      c.set("token", token);
      c.set("requiresServiceRole", false);
      c.set("userDefaultLibraryId", null);
      return next();
    }
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
    // Step 1: Verify JWT signature against the project JWKS (ES256) or
    // legacy HS256 secret.
    const payload = await verifyJWT(token);

    if (!payload) {
      throw authErrorHandlers.INVALID_TOKEN();
    }

    // Step 2: Extract user ID from Supabase JWT (uses 'sub' claim per OIDC spec)
    const userId = payload.sub;

    // Step 3: Load the profile (validation + context + default library) in a
    // single query. Banned/locked accounts are rejected here.
    const profile = await loadProfileForAuth(adminSupabase, userId);

    if (!profile) {
      const { data: userData } = await adminSupabase.auth.admin.getUserById(
        userId,
      );
      if (!userData?.user) throw authErrorHandlers.USER_NOT_FOUND();
      throw authErrorHandlers.USER_DEACTIVATED();
    }
    if (profile.user_type === "banned" || profile.is_banned === true) {
      throw authErrorHandlers.USER_DEACTIVATED();
    }
    if (profile.is_locked === true) {
      throw authErrorHandlers.USER_DEACTIVATED();
    }

    // Step 4: Set user in context
    const isPrivileged = requireAdminRole(profile);
    c.set("user", {
      id: userId,
      username: profile.username,
      email: payload.email || null,
      type: profile.user_type,
      permissions: {
        download: true,
        update: isPrivileged,
        delete: isPrivileged,
        upload: isPrivileged,
        accessAllLibraries: isPrivileged,
        accessAllTags: isPrivileged,
        accessExplicitContent: isPrivileged,
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

    c.set("userDefaultLibraryId", profile.default_library_id || null);
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
