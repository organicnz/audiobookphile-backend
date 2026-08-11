/**
 * Auth Routes
 *
 * Handles user authentication operations:
 * - Login / Signup / Logout
 * - Password Management (Forgot / Reset / Change)
 * - Token Authorization (/authorize)
 */

import { Hono } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "../_shared/types.ts";
import { getProxyOrigin } from "../../api/_shared/proxy.ts";
import {
  authErrorHandlers,
  decodeJWT,
  requireAdminRole,
  verifyJWT,
} from "../_shared/auth.ts";
import { generate2FAChallengeToken } from "../_shared/totp.ts";
import { buildUserPayload } from "../_shared/payloads.ts";
import { z } from "zod";

export const authRouter = new Hono<{ Variables: Variables }>();

// =========================
// Zod Validation Schemas
// =========================

/** Login body schema */
export const LoginBodySchema = z.object({
  username: z.string().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
});

/** Signup body schema */
export const SignupBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  username: z.string().optional(),
});

/** Refresh body schema */
export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

/** Forgot password body schema */
export const ForgotPasswordBodySchema = z.object({
  email: z.string().email("Invalid email address"),
});

/** Reset password body schema */
export const ResetPasswordBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  token: z.string().optional(),
  accessToken: z.string().optional(),
});

/** Change password body schema */
export const ChangePasswordBodySchema = z.object({
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

/** Authorize body schema (optional) */
export const AuthorizeBodySchema = z.object({
  refreshToken: z.string().optional(),
});

/** Magic link body schema */
export const MagicLinkBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  redirectTo: z.string().optional(),
});

/** Verify OTP body schema */
export const VerifyOtpBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  token: z.string().min(1, "OTP token is required"),
  type: z.string().optional(),
});

/** Invite user body schema */
export const InviteUserBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  username: z.string().optional(),
  userType: z.string().optional(),
});

// =========================
// Auth Route Handlers
// =========================

/**
 * Login - Authenticate user with username/email and password
 */
authRouter.post("/login", async (c) => {
  try {
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ||
      serviceRoleKey;

    const anonSupabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await c.req.json();

    const loginData = LoginBodySchema.parse(body);
    const { username: loginUsername, password: loginPassword } = loginData;

    let emailToUse = loginUsername;
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    if (!loginUsername.includes("@")) {
      const { data: profile } = await adminSupabase.from("profiles").select(
        "id",
      ).eq("username", loginUsername).maybeSingle();
      if (profile?.id) {
        const { data: userData } = await adminSupabase.auth.admin.getUserById(
          profile.id,
        );
        if (userData?.user?.email) emailToUse = userData.user.email;
      }
    }

    const { data: authData, error: authError } = await anonSupabase.auth
      .signInWithPassword({ email: emailToUse, password: loginPassword });

    if (authError || !authData.user) {
      return c.json({
        error: authError?.message || "Invalid email/username or password",
        code: "INVALID_CREDENTIALS",
      }, 401);
    }

    const { data: profile } = await adminSupabase.from("profiles").select("*")
      .eq("id", authData.user.id).maybeSingle();

    if (profile?.is_2fa_enabled === true) {
      const tempToken = await generate2FAChallengeToken(authData.user.id);
      return c.json({
        requires2FA: true,
        userId: authData.user.id,
        email: authData.user.email,
        tempToken,
        methods: {
          totp: Boolean(profile?.totp_secret),
          pin: Boolean(profile?.pin_code_hash),
          biometric: profile?.biometric_enrolled === true,
        },
      }, 200);
    }

    // Build user payload for client
    const userPayload = buildUserPayload(
      profile,
      {
        access_token: authData.session?.access_token || "",
        refresh_token: authData.session?.refresh_token,
      },
      {
        id: authData.user.id,
        email: authData.user.email,
        created_at: authData.user.created_at,
      },
    );

    return c.json(userPayload, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Validation error
      const message = err.issues?.[0]?.message ||
        authErrorHandlers.VALIDATION_ERROR().message;
      return c.json({
        error: message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Unauthorized") {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, authErrorHandlers.UNAUTHORIZED().statusCode);
    }
    throw err;
  }
});

/**
 * Signup - DISABLED (invitation-only)
 *
 * Public self-registration is disabled. New users can only be created
 * by admins via POST /api/auth/invite.
 */
authRouter.post("/signup", async (c) => {
  return c.json({
    error:
      "Public registration is disabled. Please contact an administrator for an invitation.",
    code: "SIGNUP_DISABLED",
  }, 403);
});

/**
 * Logout - Sign out user
 */
authRouter.post("/logout", async (c) => {
  try {
    const supabase = c.get("supabase");
    const jwt = c.req.header("Authorization")?.replace("Bearer ", "").trim() ||
      "";

    if (jwt) {
      // Verify signature first — only sign out a session the client actually owns
      const payload = await verifyJWT(jwt);
      if (payload?.sub) {
        const supabaseUrl = c.get("supabaseUrl");
        const serviceRoleKey = c.get("serviceRoleKey");
        const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

        // Sign out the user via admin API to invalidate the session
        await adminSupabase.auth.admin.signOut(payload.sub);
      }
    }

    await supabase.auth.signOut();
    return c.json({ success: true }, 200);
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, authErrorHandlers.UNAUTHORIZED().statusCode);
    }
    throw err;
  }
});

/**
 * Forgot Password - Send password reset email
 */
authRouter.post("/forgot-password", async (c) => {
  try {
    const supabase = c.get("supabase");
    const body = await c.req.json();

    const formData = ForgotPasswordBodySchema.parse(body);
    const { email } = formData;

    const siteUrl = getProxyOrigin(c);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/auth/callback?next=/reset-password`,
    });

    if (error) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }

    return c.json({ success: true, message: "Reset link sent to email" }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Reset Password - Set new password with token
 */
authRouter.post("/reset-password", async (c) => {
  try {
    const supabase = c.get("supabase");
    const body = await c.req.json();

    const resetData = ResetPasswordBodySchema.parse(body);
    const { password, token, accessToken } = resetData;

    if (!password) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }

    const authHeaderToken = c.req.header("Authorization")?.replace(
      "Bearer ",
      "",
    ).trim();
    const targetToken = authHeaderToken || accessToken || token;

    if (targetToken) {
      // Change-password affects another user's credentials — verify the token's signature
      const payload = await verifyJWT(targetToken);
      if (!payload || !payload.sub) {
        return c.json({
          error: authErrorHandlers.INVALID_TOKEN().message,
          code: authErrorHandlers.INVALID_TOKEN().code,
        }, authErrorHandlers.INVALID_TOKEN().statusCode);
      }
      const adminSupabase = createClient(
        c.get("supabaseUrl"),
        c.get("serviceRoleKey"),
      );
      const { error } = await adminSupabase.auth.admin.updateUserById(
        payload.sub,
        { password },
      );
      if (error) {
        return c.json({
          error: authErrorHandlers.VALIDATION_ERROR().message,
          code: authErrorHandlers.VALIDATION_ERROR().code,
        }, authErrorHandlers.VALIDATION_ERROR().statusCode);
      }
      return c.json({ success: true }, 200);
    }

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, authErrorHandlers.UNAUTHORIZED().statusCode);
    }

    return c.json({ success: true }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Change Password - Update current user password
 */
authRouter.post("/change-password", async (c) => {
  try {
    const body = await c.req.json();

    const formData = ChangePasswordBodySchema.parse(body);
    const { newPassword } = formData;

    if (!newPassword) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }

    const userId = c.get("userId");
    if (userId) {
      const adminSupabase = createClient(
        c.get("supabaseUrl"),
        c.get("serviceRoleKey"),
      );
      const { error } = await adminSupabase.auth.admin.updateUserById(userId, {
        password: newPassword,
      });
      if (error) {
        return c.json({
          error: authErrorHandlers.VALIDATION_ERROR().message,
          code: authErrorHandlers.VALIDATION_ERROR().code,
        }, authErrorHandlers.VALIDATION_ERROR().statusCode);
      }
      return c.json({ success: true }, 200);
    }

    const supabase = c.get("supabase");
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }

    return c.json({ success: true }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Magic Link - Send OTP login email
 */
authRouter.post("/magic-link", async (c) => {
  try {
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ||
      serviceRoleKey;

    const anonSupabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await c.req.json();
    const { email, redirectTo } = MagicLinkBodySchema.parse(body);

    const siteUrl = getProxyOrigin(c);
    const { error } = await anonSupabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: redirectTo || `${siteUrl}/auth/callback?next=/library`,
      },
    });

    if (error) {
      console.error(
        "[magic-link] Supabase signInWithOtp error:",
        error.message,
        error.code,
      );
      return c.json({
        error: error.message || authErrorHandlers.VALIDATION_ERROR().message,
        code: error.code || authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }

    return c.json({ success: true, message: "Magic link sent to email" }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const message = err.issues?.[0]?.message ||
        authErrorHandlers.VALIDATION_ERROR().message;
      return c.json({
        error: message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Verify OTP - Verify OTP token for Magic Link / Recovery
 */
authRouter.post("/verify", async (c) => {
  try {
    const supabase = c.get("supabase");
    const body = await c.req.json();
    const { email, token, type } = VerifyOtpBodySchema.parse(body);

    const { data: verifyData, error: verifyError } = await supabase.auth
      .verifyOtp({
        email,
        token,
        type: (type || "magiclink") as
          | "magiclink"
          | "recovery"
          | "signup"
          | "invite",
      });

    if (verifyError || !verifyData.session || !verifyData.user) {
      return c.json({
        error: authErrorHandlers.INVALID_TOKEN().message,
        code: authErrorHandlers.INVALID_TOKEN().code,
      }, authErrorHandlers.INVALID_TOKEN().statusCode);
    }

    const adminSupabase = createClient(
      c.get("supabaseUrl"),
      c.get("serviceRoleKey"),
    );
    const { data: profile } = await adminSupabase.from("profiles")
      .select("*").eq("id", verifyData.user.id).maybeSingle();

    const userPayload = buildUserPayload(
      profile,
      verifyData.session,
      {
        id: verifyData.user.id,
        email: verifyData.user.email,
        created_at: verifyData.user.created_at,
      },
    );

    return c.json(userPayload, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Invite User - Invite new user by email (Admin only)
 */
authRouter.post("/invite", async (c) => {
  try {
    const user = c.get("user");
    if (!requireAdminRole(user)) {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, 403);
    }

    const body = await c.req.json();
    const { email, username, userType } = InviteUserBodySchema.parse(body);

    const adminSupabase = createClient(
      c.get("supabaseUrl"),
      c.get("serviceRoleKey"),
    );
    const siteUrl = getProxyOrigin(c);
    const { data: inviteData, error: inviteError } = await adminSupabase.auth
      .admin.inviteUserByEmail(email, {
        redirectTo: `${siteUrl}/auth/callback?next=/reset-password`,
      });

    if (inviteError || !inviteData.user) {
      return c.json({
        error: inviteError?.message || "Failed to send invite",
        code: "INVITE_ERROR",
      }, 400);
    }

    await adminSupabase.from("profiles").upsert({
      id: inviteData.user.id,
      username: username || email.split("@")[0],
      user_type: userType || "user",
    });

    return c.json({ success: true, user: inviteData.user }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Refresh - Get new access token using refresh token
 */
authRouter.post("/refresh", async (c) => {
  try {
    const supabase = c.get("supabase");
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const refreshToken = c.req.header("x-refresh-token") ||
      (await c.req.json()).refreshToken;

    const refreshData = RefreshBodySchema.parse({ refreshToken });
    const { refreshToken: token } = refreshData;

    if (!token) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }

    const { data: sessionData, error: sessionError } = await supabase.auth
      .refreshSession({
        refresh_token: token,
      });

    if (sessionError || !sessionData.session) {
      // Try to decode the token to check if it's invalid
      const payload = decodeJWT(token);
      if (!payload || !payload.id) {
        return c.json({
          error: authErrorHandlers.INVALID_TOKEN().message,
          code: authErrorHandlers.INVALID_TOKEN().code,
        }, authErrorHandlers.INVALID_TOKEN().statusCode);
      }

      return c.json({
        error: authErrorHandlers.TOKEN_EXPIRED().message,
        code: authErrorHandlers.TOKEN_EXPIRED().code,
      }, authErrorHandlers.TOKEN_EXPIRED().statusCode);
    }

    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile, error: profileError } = await adminSupabase.from(
      "profiles",
    ).select("*").eq("id", sessionData.user!.id).maybeSingle();

    if (profileError) {
      return c.json({
        error: authErrorHandlers.USER_NOT_FOUND().message,
        code: authErrorHandlers.USER_NOT_FOUND().code,
      }, authErrorHandlers.USER_NOT_FOUND().statusCode);
    }

    const userPayload = buildUserPayload(
      profile,
      {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token || token,
      },
      {
        id: sessionData.user!.id,
        email: sessionData.user!.email,
        created_at: sessionData.user!.created_at,
      },
    );

    return c.json(userPayload, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

/**
 * Authorize - Validate JWT and return full user context
 * Used by mobile clients for session initialization
 */
authRouter.post("/authorize", async (c) => {
  try {
    const supabase = c.get("supabase");
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const jwt = c.req.header("Authorization")?.replace("Bearer ", "").trim() ||
      "";

    const body = await c.req.json();
    const authorizeData = AuthorizeBodySchema.parse(body);
    const providedRefreshToken = authorizeData.refreshToken || "";

    let user = null;
    let activeToken = jwt;
    let newRefreshToken: string | null = null;
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    if (jwt) {
      // Extract payload from verified JWT — critical session-establishment path
      const payload = await verifyJWT(jwt);

      if (!payload) {
        return c.json({
          error: authErrorHandlers.INVALID_TOKEN().message,
          code: authErrorHandlers.INVALID_TOKEN().code,
        }, authErrorHandlers.INVALID_TOKEN().statusCode);
      }

      const userId = payload.sub;

      // Validate user exists and is not banned/locked
      const { data: profile, error: fetchError } = await adminSupabase.from(
        "profiles",
      ).select("*").eq("id", userId).maybeSingle();

      if (fetchError || !profile) {
        // Check if auth user exists via admin API (auth schema tables are inaccessible)
        const { data: userData } = await adminSupabase.auth.admin.getUserById(
          userId,
        );

        if (userData?.user) {
          // Check if any admin exists
          const { count } = await adminSupabase.from("profiles").select("*", {
            count: "exact",
            head: true,
          }).in("user_type", ["admin", "root"]);
          const defaultRole = (count === 0 || count === null) ? "root" : "user";
          // User exists in auth but profile is missing — create one
          await adminSupabase.from("profiles").upsert({
            id: userId,
            username: payload.email?.split("@")[0] || "user",
            user_type: defaultRole,
          });
        } else {
          return c.json({
            error: authErrorHandlers.USER_NOT_FOUND().message,
            code: authErrorHandlers.USER_NOT_FOUND().code,
          }, authErrorHandlers.USER_NOT_FOUND().statusCode);
        }
      }

      user = {
        id: userId,
        email: payload.email || profile?.email || null,
        username: profile?.username || payload.email?.split("@")[0] || "User",
        created_at: new Date(profile?.created_at || Date.now()).toISOString(),
      };

      activeToken = jwt;
    }

    // If JWT is invalid, try refresh token
    if (!user && providedRefreshToken) {
      const { data: refreshData, error: refreshError } = await supabase.auth
        .refreshSession({ refresh_token: providedRefreshToken });

      if (!refreshError && refreshData.session && refreshData.user) {
        const { data: profile } = await adminSupabase.from("profiles").select(
          "*",
        ).eq("id", refreshData.user.id).maybeSingle();

        user = {
          id: refreshData.user.id,
          email: refreshData.user.email,
          username: profile?.username ||
            refreshData.user.email?.split("@")[0] || "User",
          created_at: new Date(
            profile?.created_at || refreshData.user.created_at,
          ).toISOString(),
        };

        activeToken = refreshData.session.access_token;
        newRefreshToken = refreshData.session.refresh_token;

        // Update profile
        await adminSupabase.from("profiles").update({
          username: user.username,
          user_type: profile?.user_type || "user",
        }).eq("id", user.id);
      }
    }

    if (!user) {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, authErrorHandlers.UNAUTHORIZED().statusCode);
    }

    // Fetch final profile for payload (single fetch instead of redundant re-fetches)
    const { data: finalProfile } = await adminSupabase.from("profiles").select(
      "*",
    )
      .eq("id", user.id).maybeSingle();

    const userPayload = buildUserPayload(
      finalProfile,
      { access_token: activeToken, refresh_token: newRefreshToken },
      { id: user.id, email: user.email, created_at: user.created_at },
    );

    return c.json(userPayload, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode);
    }
    throw err;
  }
});

// decodeJWT is imported from _shared/auth.ts — single source of truth
