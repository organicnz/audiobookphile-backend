import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "../_shared/types.ts";
import {
  generateTotpSecret,
  generateTotpUri,
  hashPinCode,
  verify2FAChallengeToken,
  verifyPinCode,
  verifyTotpCode,
} from "../_shared/totp.ts";

export const twoFactorRouter = new Hono<{ Variables: Variables }>();

const VerifyCodeSchema = z.object({
  code: z.string().min(6, "6-digit code is required"),
});

const EnrollPinSchema = z.object({
  pinCode: z.string().min(4, "PIN must be at least 4 digits").max(
    8,
    "PIN must be at most 8 digits",
  ),
});

const EnrollBiometricSchema = z.object({
  deviceId: z.string().optional(),
});

const DisableSchema = z.object({
  code: z.string().optional(),
  password: z.string().optional(),
  method: z.enum(["totp", "pin", "biometric", "all"]).optional(),
});

const VerifyLoginSchema = z.object({
  userId: z.string().uuid("Invalid userId"),
  code: z.string().optional(),
  tempToken: z.string().min(1, "tempToken is required"),
  method: z.enum(["totp", "pin", "biometric"]).optional(),
});

/**
 * GET /status - Get 2FA status for the authenticated user
 */
twoFactorRouter.get("/status", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const { data: profile, error } = await adminSupabase
      .from("profiles")
      .select(
        "is_2fa_enabled, totp_secret, pin_code_hash, biometric_enrolled, two_factor_methods",
      )
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return c.json({
      enabled: profile?.is_2fa_enabled === true,
      totpEnrolled: Boolean(profile?.totp_secret),
      pinEnrolled: Boolean(profile?.pin_code_hash),
      biometricEnrolled: profile?.biometric_enrolled === true,
      methods: profile?.two_factor_methods ||
        (profile?.totp_secret ? ["totp"] : []),
    }, 200);
  } catch (err: any) {
    console.error("[2fa] Failed to get status:", err);
    return c.json(
      { error: "Failed to get two-factor authentication status" },
      500,
    );
  }
});

/**
 * POST /enroll - Enroll in 2FA (generate secret and QR URI)
 */
twoFactorRouter.post("/enroll", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const secret = generateTotpSecret(20);
    const accountName = user.email || user.username || user.id;
    const uri = generateTotpUri(secret, accountName, "Audiobookphile");

    const { error } = await adminSupabase
      .from("profiles")
      .update({
        totp_secret: secret,
        is_2fa_enabled: false,
      })
      .eq("id", user.id);

    if (error) {
      throw error;
    }

    return c.json({ secret, uri }, 200);
  } catch (err: any) {
    console.error("[2fa] Failed to enroll in 2FA:", err);
    return c.json(
      { error: "Failed to initialize two-factor authentication" },
      500,
    );
  }
});

/**
 * POST /enroll-pin - Enroll in PIN Code 2FA
 */
twoFactorRouter.post("/enroll-pin", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { pinCode } = EnrollPinSchema.parse(body);

    const hash = await hashPinCode(pinCode);

    const { data: profile, error: fetchError } = await adminSupabase
      .from("profiles")
      .select("two_factor_methods")
      .eq("id", user.id)
      .maybeSingle();

    if (fetchError || !profile) {
      return c.json({ error: "Profile not found" }, 404);
    }

    const currentMethods = Array.isArray(profile.two_factor_methods)
      ? profile.two_factor_methods
      : [];
    const updatedMethods = Array.from(new Set([...currentMethods, "pin"]));

    const { error } = await adminSupabase
      .from("profiles")
      .update({
        pin_code_hash: hash,
        is_2fa_enabled: true,
        two_factor_methods: updatedMethods,
      })
      .eq("id", user.id);

    if (error) {
      throw error;
    }

    return c.json({ success: true, enrolled: "pin" }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[2fa] Failed to enroll in PIN 2FA:", err);
    return c.json({
      error: "Failed to enroll in PIN code two-factor authentication",
    }, 500);
  }
});

/**
 * POST /enroll-biometric - Enroll in Facial 2FA / Biometric Sign-In
 */
twoFactorRouter.post("/enroll-biometric", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json().catch(() => ({}));
    const { deviceId } = EnrollBiometricSchema.parse(body);

    const { data: profile, error: fetchError } = await adminSupabase
      .from("profiles")
      .select("two_factor_methods")
      .eq("id", user.id)
      .maybeSingle();

    if (fetchError || !profile) {
      return c.json({ error: "Profile not found" }, 404);
    }

    const currentMethods = Array.isArray(profile.two_factor_methods)
      ? profile.two_factor_methods
      : [];
    const updatedMethods = Array.from(
      new Set([...currentMethods, "biometric"]),
    );

    const { error } = await adminSupabase
      .from("profiles")
      .update({
        biometric_enrolled: true,
        biometric_device_id: deviceId || "default",
        is_2fa_enabled: true,
        two_factor_methods: updatedMethods,
      })
      .eq("id", user.id);

    if (error) {
      throw error;
    }

    return c.json({ success: true, enrolled: "biometric" }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[2fa] Failed to enroll in Biometric 2FA:", err);
    return c.json({
      error: "Failed to enroll in Facial 2FA / Biometric authentication",
    }, 500);
  }
});

/**
 * POST /verify - Confirm and activate 2FA enrollment with 6-digit code
 */
twoFactorRouter.post("/verify", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { code } = VerifyCodeSchema.parse(body);

    const { data: profile, error: fetchError } = await adminSupabase
      .from("profiles")
      .select("totp_secret, is_2fa_enabled, two_factor_methods")
      .eq("id", user.id)
      .maybeSingle();

    if (fetchError || !profile || !profile.totp_secret) {
      return c.json({
        error: "Please enroll in two-factor authentication first",
      }, 400);
    }

    const isValid = await verifyTotpCode(profile.totp_secret, code);
    if (!isValid) {
      return c.json({
        error:
          "Invalid verification code. Please check your authenticator app.",
      }, 400);
    }

    const currentMethods = Array.isArray(profile.two_factor_methods)
      ? profile.two_factor_methods
      : [];
    const updatedMethods = Array.from(new Set([...currentMethods, "totp"]));

    const { error: updateError } = await adminSupabase
      .from("profiles")
      .update({
        is_2fa_enabled: true,
        two_factor_methods: updatedMethods,
      })
      .eq("id", user.id);

    if (updateError) {
      throw updateError;
    }

    return c.json({ success: true, enabled: true }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[2fa] Failed to verify 2FA:", err);
    return c.json({ error: "Failed to verify two-factor authentication" }, 500);
  }
});

/**
 * POST /disable - Disable 2FA with verification code or password
 */
twoFactorRouter.post("/disable", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabase = c.get("supabase");
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { code, password } = DisableSchema.parse(body);

    const { data: profile, error: fetchError } = await adminSupabase
      .from("profiles")
      .select("totp_secret, is_2fa_enabled")
      .eq("id", user.id)
      .maybeSingle();

    if (fetchError || !profile) {
      return c.json({ error: "Profile not found" }, 404);
    }

    if (!profile.is_2fa_enabled) {
      return c.json({ success: true, enabled: false }, 200);
    }

    let authorized = false;

    if (code && profile.totp_secret) {
      authorized = await verifyTotpCode(profile.totp_secret, code);
    }

    if (!authorized && password && user.email) {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (!authError) {
        authorized = true;
      }
    }

    if (!authorized) {
      return c.json(
        {
          error:
            "Valid 6-digit authenticator code or account password is required to disable 2FA",
        },
        400,
      );
    }

    const { error: updateError } = await adminSupabase
      .from("profiles")
      .update({
        is_2fa_enabled: false,
        totp_secret: null,
        pin_code_hash: null,
        biometric_enrolled: false,
        two_factor_methods: [],
      })
      .eq("id", user.id);

    if (updateError) {
      throw updateError;
    }

    return c.json({ success: true, enabled: false }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[2fa] Failed to disable 2FA:", err);
    return c.json(
      { error: "Failed to disable two-factor authentication" },
      500,
    );
  }
});

/**
 * POST /verify-login - Verify 2FA challenge during sign in
 */
twoFactorRouter.post("/verify-login", async (c) => {
  const supabase = c.get("supabase");
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { userId, code, tempToken, method } = VerifyLoginSchema.parse(body);

    const isTokenValid = await verify2FAChallengeToken(tempToken, userId);
    if (!isTokenValid) {
      return c.json(
        { error: "Login challenge expired. Please log in again." },
        401,
      );
    }

    const { data: profile, error: profileError } = await adminSupabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (profileError || !profile) {
      return c.json({ error: "User profile not found" }, 404);
    }

    if (!profile.is_2fa_enabled) {
      return c.json({
        error: "Two-factor authentication is not enabled for this account",
      }, 400);
    }

    const effectiveMethod = method ||
      (code === "biometric"
        ? "biometric"
        : (code && code.length !== 6 ? "pin" : "totp"));

    if (effectiveMethod === "biometric") {
      if (profile.biometric_enrolled !== true) {
        return c.json(
          { error: "Facial 2FA is not enrolled for this account" },
          400,
        );
      }
    } else if (effectiveMethod === "pin") {
      if (!profile.pin_code_hash || !code) {
        return c.json({
          error: "PIN code 2FA is not enrolled or PIN code is missing",
        }, 400);
      }
      const isValid = await verifyPinCode(code, profile.pin_code_hash);
      if (!isValid) {
        return c.json({ error: "Invalid PIN code. Please try again." }, 401);
      }
    } else {
      if (!profile.totp_secret || !code) {
        return c.json({
          error: "Authenticator app 2FA is not enrolled or code is missing",
        }, 400);
      }
      const isCodeValid = await verifyTotpCode(profile.totp_secret, code);
      if (!isCodeValid) {
        return c.json({
          error:
            "Invalid authentication code. Please check your authenticator app.",
        }, 401);
      }
    }

    const { data: userData } = await adminSupabase.auth.admin.getUserById(
      userId,
    );
    const userEmail = userData?.user?.email;

    if (!userEmail) {
      return c.json({ error: "User email not found" }, 500);
    }

    const { data: linkData, error: linkError } = await adminSupabase.auth.admin
      .generateLink({
        type: "magiclink",
        email: userEmail,
      });

    if (linkError || !linkData?.properties?.hashed_token) {
      console.error("[2fa] Failed to generate login session link:", linkError);
      return c.json({ error: "Failed to establish user session" }, 500);
    }

    const { data: verifyData, error: verifyError } = await supabase.auth
      .verifyOtp({
        email: userEmail,
        token: linkData.properties.hashed_token,
        type: "magiclink",
      });

    if (verifyError || !verifyData.session || !verifyData.user) {
      console.error("[2fa] Failed to verify login OTP:", verifyError);
      return c.json({ error: "Failed to establish user session" }, 500);
    }

    const userPayload = {
      user: {
        id: verifyData.user.id,
        username: profile?.username || verifyData.user.email?.split("@")[0] ||
          "User",
        email: verifyData.user.email,
        type: profile?.user_type || "user",
        token: verifyData.session.access_token,
        refreshToken: verifyData.session.refresh_token,
        mediaProgress: [],
        seriesHideFromContinueListening: [],
        bookmarks: [],
        isActive: true,
        isLocked: false,
        lastSeen: Date.now(),
        createdAt: new Date(profile?.created_at || verifyData.user.created_at)
          .getTime(),
        permissions: {
          download: true,
          update: profile?.user_type === "admin",
          delete: profile?.user_type === "admin",
          upload: profile?.user_type === "admin",
          accessAllLibraries: true,
          accessAllTags: true,
          accessExplicitContent: true,
        },
        librariesAccessible: [],
        itemTagsAccessible: [],
      },
      userDefaultLibraryId: profile?.default_library_id || null,
      serverSettings: {},
      source: "local",
    };

    return c.json(userPayload, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[2fa] verify-login failed:", err);
    return c.json({
      error: "An unexpected error occurred during two-factor authentication",
    }, 500);
  }
});
