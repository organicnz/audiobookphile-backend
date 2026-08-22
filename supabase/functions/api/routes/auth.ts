/**
 * Auth Routes
 *
 * Handles user authentication operations:
 * - Login / Signup / Logout
 * - Password Management (Forgot / Reset / Change)
 * - Token Authorization (/authorize)
 *
 * Schema-first: every route is declared via createRoute (see
 * _shared/openapi.ts) so the OpenAPI document, Schemathesis fuzzing and the
 * post-deploy smoke suite all derive from these definitions.
 */

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { getWebOrigin } from "../../api/_shared/proxy.ts";
import {
  authErrorHandlers,
  decodeJWT,
  requireAdminRole,
  verifyJWT,
} from "../_shared/auth.ts";
import { generate2FAChallengeToken } from "../_shared/totp.ts";
import { buildUserPayload } from "../_shared/payloads.ts";
import { z } from "zod";
import {
  createOpenApiRouter,
  FlatErrorSchema,
  LoginResponseSchema,
  SuccessSchema,
  UserPayloadSchema,
} from "../_shared/openapi.ts";

export const authRouter = createOpenApiRouter();

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
  client: z.enum(["ios", "web"]).optional(),
  server: z.string().optional(),
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
// OpenAPI Route Definitions
// =========================

const loginRoute = {
  method: "post" as const,
  path: "/login",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: LoginBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Authenticated session payload or 2FA challenge",
      content: {
        "application/json": { schema: LoginResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    401: {
      description: "Invalid credentials",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const signupRoute = {
  method: "post" as const,
  path: "/signup",
  tags: ["auth"],
  // No request body declared: the handler never reads one and always
  // responds 403 — declaring a schema would make validation (400) fire
  // before the invitation-only gate.
  responses: {
    403: {
      description: "Public registration is disabled (invitation-only)",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const logoutRoute = {
  method: "post" as const,
  path: "/logout",
  tags: ["auth"],
  responses: {
    200: {
      description: "Signed out",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const forgotPasswordRoute = {
  method: "post" as const,
  path: "/forgot-password",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: ForgotPasswordBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Reset link sent",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    400: {
      description: "Validation or send error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const resetPasswordRoute = {
  method: "post" as const,
  path: "/reset-password",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: ResetPasswordBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Password updated",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    401: {
      description: "Invalid or expired token",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const changePasswordRoute = {
  method: "post" as const,
  path: "/change-password",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: ChangePasswordBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Password updated",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const magicLinkRoute = {
  method: "post" as const,
  path: "/magic-link",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: MagicLinkBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Magic link sent",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    400: {
      description: "Validation, redirect or send error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const verifyOtpRoute = {
  method: "post" as const,
  path: "/verify",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: VerifyOtpBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Authenticated session payload",
      content: {
        "application/json": { schema: UserPayloadSchema },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    401: {
      description: "Invalid or expired token",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const inviteRoute = {
  method: "post" as const,
  path: "/invite",
  tags: ["auth"],
  request: {
    body: {
      content: {
        // Partial so the admin-role gate (403) fires before body
        // validation (400), preserving the legacy precedence.
        "application/json": { schema: InviteUserBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Invite sent",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            user: z.object({ id: z.string() }).passthrough(),
          }),
        },
      },
    },
    400: {
      description: "Invite error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    403: {
      description: "Admin role required",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const refreshRoute = {
  method: "post" as const,
  path: "/refresh",
  tags: ["auth"],
  // The refresh token is accepted either in the x-refresh-token header (iOS
  // silent refresh, body absent) or the body. The body schema is partial so
  // header-driven requests with an empty body keep working.
  request: {
    body: {
      content: {
        "application/json": { schema: RefreshBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Refreshed session payload",
      content: {
        "application/json": { schema: UserPayloadSchema },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    401: {
      description: "Invalid or expired refresh token",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

const authorizeRoute = {
  method: "post" as const,
  path: "/authorize",
  tags: ["auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: AuthorizeBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Session payload",
      content: {
        "application/json": { schema: UserPayloadSchema },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    401: {
      description: "No valid session",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

// =========================
// Auth Route Handlers
// =========================

/**
 * Login - Authenticate user with username/email and password
 */
authRouter.openapi(loginRoute, async (c) => {
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
      // Issue a single-use 2FA challenge: a fresh random nonce is persisted
      // on the profile and signed into the challenge token. verify-login /
      // webauthn login-verify require the nonce to match and consume it.
      const nonce = crypto.randomUUID();
      const lockUntil = profile?.two_factor_locked_until
        ? new Date(profile.two_factor_locked_until).getTime()
        : null;
      // Clear the brute-force guard ONLY when a lock existed and has since
      // expired; the attempt counter must survive across challenge
      // issuances, otherwise an attacker can reset it by logging in again.
      const guardReset: Record<string, unknown> = {};
      if (lockUntil !== null && lockUntil <= Date.now()) {
        guardReset.two_factor_failed_attempts = 0;
        guardReset.two_factor_locked_until = null;
      }
      await adminSupabase.from("profiles").update({
        two_factor_challenge_nonce: nonce,
        ...guardReset,
      }).eq("id", authData.user.id);

      const { data: passkeys } = await adminSupabase
        .from("webauthn_credentials")
        .select("id")
        .eq("user_id", authData.user.id);

      const tempToken = await generate2FAChallengeToken(
        authData.user.id,
        nonce,
      );
      return c.json({
        requires2FA: true as const,
        userId: authData.user.id,
        email: authData.user.email,
        tempToken,
        methods: {
          totp: Boolean(profile?.totp_secret),
          pin: Boolean(profile?.pin_code_hash),
          biometric: profile?.biometric_enrolled === true &&
            Array.isArray(passkeys) &&
            passkeys.length > 0,
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Unauthorized") {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, authErrorHandlers.UNAUTHORIZED().statusCode as 401);
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
authRouter.openapi(signupRoute, async (c) => {
  return c.json({
    error:
      "Public registration is disabled. Please contact an administrator for an invitation.",
    code: "SIGNUP_DISABLED",
  }, 403);
});

/**
 * Logout - Sign out user
 */
authRouter.openapi(logoutRoute, async (c) => {
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
      }, authErrorHandlers.UNAUTHORIZED().statusCode as 401);
    }
    throw err;
  }
});

/**
 * Forgot Password - Send password reset email
 */
authRouter.openapi(forgotPasswordRoute, async (c) => {
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

    const formData = ForgotPasswordBodySchema.parse(body);
    const { email } = formData;

    const siteUrl = getWebOrigin(c);
    const { error } = await anonSupabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/auth/callback?next=/reset-password`,
    });

    if (error) {
      console.error(
        "[forgot-password] Supabase resetPasswordForEmail error:",
        error.message,
        error.code,
      );
      return c.json({
        error: error.message || "Failed to send reset email.",
        code: error.code || "RESET_PASSWORD_ERROR",
      }, 400);
    }

    return c.json({ success: true, message: "Reset link sent to email" }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const message = err.issues?.[0]?.message || "Validation error";
      return c.json({
        error: message,
        code: "VALIDATION_ERROR",
      }, 400);
    }
    if (err instanceof Error && err.message) {
      return c.json({
        error: err.message,
        code: "VALIDATION_ERROR",
      }, 400);
    }
    throw err;
  }
});

/**
 * Reset Password - Set new password with token
 */
authRouter.openapi(resetPasswordRoute, async (c) => {
  try {
    const supabase = c.get("supabase");
    const body = await c.req.json();

    const resetData = ResetPasswordBodySchema.parse(body);
    const { password, token, accessToken } = resetData;

    if (!password) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
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
        }, authErrorHandlers.INVALID_TOKEN().statusCode as 401);
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
        }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
      }
      return c.json({ success: true }, 200);
    }

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      return c.json({
        error: authErrorHandlers.UNAUTHORIZED().message,
        code: authErrorHandlers.UNAUTHORIZED().code,
      }, authErrorHandlers.UNAUTHORIZED().statusCode as 401);
    }

    return c.json({ success: true }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

/**
 * Change Password - Update current user password
 */
authRouter.openapi(changePasswordRoute, async (c) => {
  try {
    const body = await c.req.json();

    const formData = ChangePasswordBodySchema.parse(body);
    const { newPassword } = formData;

    if (!newPassword) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
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
        }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
      }
      return c.json({ success: true }, 200);
    }

    const supabase = c.get("supabase");
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }

    return c.json({ success: true }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

/**
 * Magic Link - Send OTP login email
 */
authRouter.openapi(magicLinkRoute, async (c) => {
  try {
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const supabaseEnvUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ||
      serviceRoleKey;

    const anonSupabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await c.req.json();
    const { email, redirectTo, client, server } = MagicLinkBodySchema.parse(
      body,
    );

    const siteUrl = getWebOrigin(c);

    // Only allow redirect targets under our own web origin or the iOS app's
    // custom scheme. Client-supplied redirectTo must never point at a
    // third-party host (open-redirect / phishing vector).
    const allowedPrefixes = [siteUrl, "audiobookphile://"];
    const redirectAllowed = !redirectTo ||
      allowedPrefixes.some((prefix) => redirectTo.startsWith(prefix));
    if (!redirectAllowed) {
      return c.json({
        error: "Invalid redirect target",
        code: "INVALID_REDIRECT",
      }, 400);
    }

    // The app echoes the API base URL back so the deep link can configure the
    // session on the requesting device. Restrict it to our own origins.
    const serverAllowed = !server ||
      server.startsWith(siteUrl) ||
      server.startsWith(supabaseEnvUrl);
    if (!serverAllowed) {
      return c.json({
        error: "Invalid server target",
        code: "INVALID_SERVER",
      }, 400);
    }

    let target = redirectTo ||
      `${siteUrl}/auth/callback?next=/library`;
    if (client === "ios") {
      target = `${target.split("?")[0]}?next=/library&client=ios`;
      if (server) {
        target += `&server=${encodeURIComponent(server)}`;
      }
    }

    const { error } = await anonSupabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: target,
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }

    return c.json({ success: true, message: "Magic link sent to email" }, 200);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const message = err.issues?.[0]?.message ||
        authErrorHandlers.VALIDATION_ERROR().message;
      return c.json({
        error: message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

/**
 * Verify OTP - Verify OTP token for Magic Link / Recovery
 */
authRouter.openapi(verifyOtpRoute, async (c) => {
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
    const { email, token, type } = VerifyOtpBodySchema.parse(body);

    const { data: verifyData, error: verifyError } = await anonSupabase.auth
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
        error: verifyError?.message ||
          authErrorHandlers.INVALID_TOKEN().message,
        code: authErrorHandlers.INVALID_TOKEN().code,
      }, authErrorHandlers.INVALID_TOKEN().statusCode as 401);
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

/**
 * Invite User - Invite new user by email (Admin only)
 */
authRouter.openapi(inviteRoute, async (c) => {
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
    const siteUrl = getWebOrigin(c);
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

/**
 * Refresh - Get new access token using refresh token
 */
authRouter.openapi(refreshRoute, async (c) => {
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
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
        }, authErrorHandlers.INVALID_TOKEN().statusCode as 401);
      }

      return c.json({
        error: authErrorHandlers.TOKEN_EXPIRED().message,
        code: authErrorHandlers.TOKEN_EXPIRED().code,
      }, authErrorHandlers.TOKEN_EXPIRED().statusCode as 401);
    }

    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile, error: profileError } = await adminSupabase.from(
      "profiles",
    ).select("*").eq("id", sessionData.user!.id).maybeSingle();

    if (profileError) {
      return c.json({
        error: authErrorHandlers.USER_NOT_FOUND().message,
        code: authErrorHandlers.USER_NOT_FOUND().code,
      }, authErrorHandlers.USER_NOT_FOUND().statusCode as any);
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

/**
 * Authorize - Validate JWT and return full user context
 * Used by mobile clients for session initialization
 */
authRouter.openapi(authorizeRoute, async (c) => {
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
        }, authErrorHandlers.INVALID_TOKEN().statusCode as 401);
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
          }, authErrorHandlers.USER_NOT_FOUND().statusCode as any);
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
      }, authErrorHandlers.UNAUTHORIZED().statusCode as 401);
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
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    if (err instanceof Error && err.message === "Validation error") {
      return c.json({
        error: authErrorHandlers.VALIDATION_ERROR().message,
        code: authErrorHandlers.VALIDATION_ERROR().code,
      }, authErrorHandlers.VALIDATION_ERROR().statusCode as 400);
    }
    throw err;
  }
});

// decodeJWT is imported from _shared/auth.ts — single source of truth

// =========================
// E2E Test Account Provisioning
// =========================

/**
 * Idempotently ensures the Maestro e2e test account exists (email confirmed,
 * known password, profile row) so CI smoke tests and UI e2e suites can sign
 * in without a dashboard-fetched service key: this function runs with the
 * platform-injected SUPABASE_SERVICE_ROLE_KEY.
 *
 * Guarded by the X-E2E-Secret header (E2E_PROVISIONING_SECRET edge secret).
 * The account identity comes from MAESTRO_TEST_EMAIL / MAESTRO_TEST_PASSWORD
 * edge secrets — nothing is taken from the request body.
 */
const e2eProvisionRoute = {
  method: "post" as const,
  path: "/e2e/provision",
  tags: ["auth"],
  summary: "Ensure the e2e test account exists (secret-guarded)",
  request: {
    headers: z.object({
      "x-e2e-secret": z.string().min(1),
    }),
  },
  responses: {
    200: {
      description: "Account ensured",
      content: {
        "application/json": { schema: SuccessSchema },
      },
    },
    403: {
      description: "Missing or wrong provisioning secret",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    502: {
      description: "Account creation failed",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
    503: {
      description: "E2E account not configured",
      content: {
        "application/json": { schema: FlatErrorSchema },
      },
    },
  },
};

authRouter.openapi(e2eProvisionRoute, async (c) => {
  const expected = Deno.env.get("E2E_PROVISIONING_SECRET") ?? "";
  const provided = c.req.header("X-E2E-Secret") ?? "";
  if (expected.length === 0 || provided !== expected) {
    return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  }

  const email = Deno.env.get("MAESTRO_TEST_EMAIL") ?? "";
  const password = Deno.env.get("MAESTRO_TEST_PASSWORD") ?? "";
  if (!email || !password) {
    return c.json({
      error: "E2E account not configured (MAESTRO_TEST_* secrets missing)",
      code: "NOT_CONFIGURED",
    }, 503);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: existing } = await adminSupabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const user = (existing?.users ?? []).find((u) => u.email === email);

  let userId: string;
  if (user) {
    await adminSupabase.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
    });
    userId = user.id;
  } else {
    const { data: created, error: createError } = await adminSupabase.auth.admin
      .createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username: email },
      });
    if (createError || !created?.user) {
      return c.json({
        error: createError?.message ?? "Failed to create e2e account",
        code: "PROVISION_FAILED",
      }, 502);
    }
    userId = created.user.id;
  }

  await adminSupabase.from("profiles").upsert({
    id: userId,
    username: email,
    user_type: "user",
  }, { onConflict: "id" });

  return c.json({
    success: true,
    message: `e2e account ensured (${email}, ${userId.slice(0, 8)})`,
  }, 200);
});
