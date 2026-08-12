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
import {
  evaluate2FALockout,
  lockoutError,
  register2FAFailure,
  reset2FAGuard,
} from "../_shared/twoFactorGuard.ts";
import { mintSessionFor2FAUser } from "../_shared/sessions.ts";

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
        "is_2fa_enabled, totp_secret, pin_code_hash, biometric_enrolled, two_factor_methods, two_factor_failed_attempts, two_factor_locked_until",
      )
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const { data: passkeys, error: passkeyError } = await adminSupabase
      .from("webauthn_credentials")
      .select("id, credential_id, device_name, created_at, last_used_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (passkeyError) {
      throw passkeyError;
    }

    const hasPasskeys = Array.isArray(passkeys) && passkeys.length > 0;
    const lockout = evaluate2FALockout(profile || {});

    return c.json({
      enabled: profile?.is_2fa_enabled === true,
      totpEnrolled: Boolean(profile?.totp_secret),
      pinEnrolled: Boolean(profile?.pin_code_hash),
      biometricEnrolled: profile?.biometric_enrolled === true &&
        hasPasskeys,
      passkeys: (passkeys || []).map((pk: any) => ({
        id: pk.id,
        credentialId: pk.credential_id,
        deviceName: pk.device_name || "Passkey",
        createdAt: pk.created_at,
        lastUsedAt: pk.last_used_at,
      })),
      methods: profile?.two_factor_methods ||
        (profile?.totp_secret ? ["totp"] : []),
      lockout: lockout.locked
        ? { locked: true, remainingSeconds: lockout.remainingSeconds }
        : { locked: false, remainingSeconds: 0 },
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
      .select(
        "totp_secret, pin_code_hash, is_2fa_enabled, two_factor_failed_attempts, two_factor_locked_until",
      )
      .eq("id", user.id)
      .maybeSingle();

    if (fetchError || !profile) {
      return c.json({ error: "Profile not found" }, 404);
    }

    if (!profile.is_2fa_enabled) {
      return c.json({ success: true, enabled: false }, 200);
    }

    const lockout = evaluate2FALockout(profile);
    if (lockout.locked) {
      return c.json(lockoutError(lockout), 429);
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
      await register2FAFailure(adminSupabase, user.id);
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
        two_factor_failed_attempts: 0,
        two_factor_locked_until: null,
        two_factor_challenge_nonce: null,
      })
      .eq("id", user.id);

    if (updateError) {
      throw updateError;
    }

    const { error: credsError } = await adminSupabase
      .from("webauthn_credentials")
      .delete()
      .eq("user_id", user.id);

    if (credsError) {
      throw credsError;
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
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { userId, code, tempToken, method } = VerifyLoginSchema.parse(body);

    const tokenPayload = await verify2FAChallengeToken(tempToken, userId);
    if (!tokenPayload) {
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

    // Single-use challenge nonce must match the one issued at login time.
    if (profile.two_factor_challenge_nonce !== tokenPayload.nonce) {
      return c.json({
        error: "Login challenge is invalid. Please log in again.",
      }, 401);
    }

    // Brute-force lockout guard (TOTP/PIN attempts are limited).
    const lockout = evaluate2FALockout(profile);
    if (lockout.locked) {
      return c.json(lockoutError(lockout), 429);
    }

    const effectiveMethod = method ||
      (code === "biometric"
        ? "biometric"
        : (code && code.length !== 6 ? "pin" : "totp"));

    let verified = false;

    if (effectiveMethod === "biometric") {
      // Biometric 2FA must be backed by a registered passkey. The literal
      // "biometric" code is only accepted through the WebAuthn login flow;
      // it is rejected here unless the account has a real passkey AND the
      // caller proves possession via the /webauthn/login/verify endpoint.
      const { data: passkeys } = await adminSupabase
        .from("webauthn_credentials")
        .select("id")
        .eq("user_id", userId);
      if (
        profile.biometric_enrolled !== true ||
        !Array.isArray(passkeys) ||
        passkeys.length === 0
      ) {
        return c.json(
          { error: "Facial 2FA is not enrolled for this account" },
          400,
        );
      }
      return c.json({
        error: "Use the passkey sign-in flow to authenticate with biometrics.",
        code: "BIOMETRIC_REQUIRES_WEBAUTHN",
      }, 400);
    } else if (effectiveMethod === "pin") {
      if (!profile.pin_code_hash || !code) {
        return c.json({
          error: "PIN code 2FA is not enrolled or PIN code is missing",
        }, 400);
      }
      const pinResult = await verifyPinCode(code, profile.pin_code_hash);
      const isPinValid = pinResult === true ||
        (typeof pinResult === "object" && pinResult.valid);
      verified = isPinValid;
      // Migrate legacy SHA-256 hash to PBKDF2 transparently
      if (typeof pinResult === "object" && pinResult.rehash) {
        await adminSupabase.from("profiles").update({
          pin_code_hash: pinResult.rehash,
        }).eq("id", userId);
      }
    } else {
      if (!profile.totp_secret || !code) {
        return c.json({
          error: "Authenticator app 2FA is not enrolled or code is missing",
        }, 400);
      }
      verified = await verifyTotpCode(profile.totp_secret, code);
    }

    if (!verified) {
      const updatedLockout = await register2FAFailure(adminSupabase, userId);
      if (updatedLockout.locked) {
        return c.json(lockoutError(updatedLockout), 429);
      }
      return c.json({
        error:
          "Invalid authentication code. Please check your authenticator app.",
      }, 401);
    }

    // 2FA verified — consume the single-use nonce and reset the guard.
    await reset2FAGuard(adminSupabase, userId, null);

    const userPayload = await mintSessionFor2FAUser(
      supabaseUrl,
      serviceRoleKey,
      userId,
    );

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
