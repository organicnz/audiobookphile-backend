/**
 * WebAuthn (passkey) 2FA router.
 *
 *  - POST /register/options   (authenticated)  start passkey enrollment
 *  - POST /register/verify    (authenticated)  verify + store the credential
 *  - POST /login/options      (public)         passkey challenge for 2FA login
 *  - POST /login/verify       (public)         verify assertion + mint session
 *
 * Endpoints mounted at BOTH /api/auth/2fa/webauthn/* and /api/2fa/webauthn/*.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "../_shared/types.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  generateChallenge,
  sha256Hex,
  verifyAssertion,
  verifyRegistration,
} from "../_shared/webauthn.ts";
import { verify2FAChallengeToken } from "../_shared/totp.ts";
import {
  evaluate2FALockout,
  lockoutError,
  register2FAFailure,
  reset2FAGuard,
} from "../_shared/twoFactorGuard.ts";
import { mintSessionFor2FAUser } from "../_shared/sessions.ts";

export const webauthnRouter = new Hono<{ Variables: Variables }>();

const RegisterOptionsSchema = z.object({
  deviceName: z.string().max(64).optional(),
  excludeCredentials: z.array(z.string().min(1)).optional(),
});

const RegisterVerifySchema = z.object({
  id: z.string().min(1),
  clientDataJSON: z.string().min(1),
  attestationObject: z.string().min(1),
  transports: z.array(z.string()).optional(),
  deviceName: z.string().max(64).optional(),
});

const LoginOptionsSchema = z.object({
  userId: z.string().uuid("Invalid userId"),
  tempToken: z.string().min(1, "tempToken is required"),
});

const LoginVerifySchema = z.object({
  userId: z.string().uuid("Invalid userId"),
  tempToken: z.string().min(1, "tempToken is required"),
  credentialId: z.string().min(1),
  clientDataJSON: z.string().min(1),
  authenticatorData: z.string().min(1),
  signature: z.string().min(1),
});

const PasskeyRemoveSchema = z.object({
  credentialId: z.string().min(1),
});

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function getRpConfig() {
  const origin = Deno.env.get("WEBAUTHN_ORIGIN") ||
    Deno.env.get("NEXT_PUBLIC_SITE_URL") ||
    "https://audiobookphile.vercel.app";
  const rpId = Deno.env.get("WEBAUTHN_RP_ID") || new URL(origin).hostname;
  return {
    origin: origin.replace(/\/+$/, ""),
    rpId,
    rpName: Deno.env.get("WEBAUTHN_RP_NAME") || "Audiobookphile",
  };
}

async function storeChallenge(
  adminSupabase: any,
  userId: string,
  challenge: string,
  purpose: "register" | "login",
) {
  await adminSupabase.from("webauthn_challenges").update({ used: true })
    .eq("user_id", userId).eq("purpose", purpose).eq("used", false);

  await adminSupabase.from("webauthn_challenges").insert({
    user_id: userId,
    challenge,
    purpose,
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
}

async function consumeChallenge(
  adminSupabase: any,
  userId: string,
  purpose: "register" | "login",
  challenge: string,
): Promise<boolean> {
  const { data } = await adminSupabase.from("webauthn_challenges")
    .select("id, expires_at")
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .eq("challenge", challenge)
    .eq("used", false)
    .maybeSingle();

  if (!data) return false;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return false;

  await adminSupabase.from("webauthn_challenges").update({ used: true })
    .eq("id", data.id);
  return true;
}

/**
 * POST /register/options - start passkey enrollment (requires session)
 */
webauthnRouter.post("/register/options", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json().catch(() => ({}));
    const { deviceName } = RegisterOptionsSchema.parse(body);
    const { rpId, rpName } = getRpConfig();
    void deviceName; // accepted for future per-device labels
    const challenge = generateChallenge();
    await storeChallenge(adminSupabase, user.id, challenge, "register");

    const options = {
      rp: { name: rpName, id: rpId },
      user: {
        id: base64UrlEncode(new TextEncoder().encode(user.id)),
        name: user.email || user.username || user.id,
        displayName: user.username || user.email || user.id,
      },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256
      timeout: 60_000,
      attestation: "none",
      excludeCredentials: (body.excludeCredentials || []).map((id: string) => ({
        type: "public-key",
        id,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      extensions: { credProps: true },
    };

    return c.json(options, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[webauthn] register/options failed:", err);
    return c.json({ error: "Failed to start passkey enrollment" }, 500);
  }
});

/**
 * POST /register/verify - verify attestation and store the credential
 */
webauthnRouter.post("/register/verify", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const payload = RegisterVerifySchema.parse(body);
    const { origin, rpId } = getRpConfig();

    const { data: pending } = await adminSupabase.from(
      "webauthn_challenges",
    ).select("challenge, expires_at").eq("user_id", user.id)
      .eq("purpose", "register").eq("used", false).order("created_at", {
        ascending: false,
      }).limit(1).maybeSingle();

    if (
      !pending || new Date(pending.expires_at as string).getTime() < Date.now()
    ) {
      return c.json({
        error: "Passkey enrollment expired. Please try again.",
      }, 400);
    }

    const credential = await verifyRegistration(
      base64UrlDecode(payload.clientDataJSON),
      base64UrlDecode(payload.attestationObject),
      pending.challenge,
      origin,
      rpId,
    );

    await consumeChallenge(
      adminSupabase,
      user.id,
      "register",
      pending.challenge,
    );

    const { data: existing } = await adminSupabase.from(
      "webauthn_credentials",
    ).select("id").eq("user_id", user.id).eq(
      "credential_id",
      credential.credentialId,
    )
      .maybeSingle();
    if (existing) {
      return c.json({ error: "This passkey is already registered." }, 409);
    }

    const { error: insertError } = await adminSupabase.from(
      "webauthn_credentials",
    ).insert({
      user_id: user.id,
      credential_id: credential.credentialId,
      public_key: base64UrlEncode(credential.publicKey),
      counter: credential.signCount,
      transports: payload.transports || [],
      device_name: payload.deviceName || "Passkey",
    });

    if (insertError) {
      throw insertError;
    }

    const { data: profile } = await adminSupabase.from("profiles").select(
      "two_factor_methods",
    ).eq("id", user.id).maybeSingle();
    const currentMethods = Array.isArray(profile?.two_factor_methods)
      ? profile.two_factor_methods
      : [];
    const updatedMethods = Array.from(
      new Set([...currentMethods, "biometric"]),
    );

    await adminSupabase.from("profiles").update({
      biometric_enrolled: true,
      is_2fa_enabled: true,
      two_factor_methods: updatedMethods,
    }).eq("id", user.id);

    return c.json({
      success: true,
      enrolled: "biometric",
      credentialId: credential.credentialId,
    }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[webauthn] register/verify failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Passkey registration failed: ${message}` }, 400);
  }
});

/**
 * POST /login/options - passkey challenge during 2FA sign-in (public)
 */
webauthnRouter.post("/login/options", async (c) => {
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { userId, tempToken } = LoginOptionsSchema.parse(body);

    const tokenPayload = await verify2FAChallengeToken(tempToken, userId);
    if (!tokenPayload) {
      return c.json(
        { error: "Login challenge expired. Please log in again." },
        401,
      );
    }

    const { data: profile } = await adminSupabase.from("profiles").select("*")
      .eq("id", userId).maybeSingle();
    if (!profile || profile.is_2fa_enabled !== true) {
      return c.json({
        error: "Two-factor authentication is not enabled for this account",
      }, 400);
    }

    const lockout = evaluate2FALockout(profile);
    if (lockout.locked) {
      return c.json(lockoutError(lockout), 429);
    }

    if (profile.two_factor_challenge_nonce !== tokenPayload.nonce) {
      return c.json({
        error: "Login challenge is invalid. Please log in again.",
      }, 401);
    }

    const { data: credentials, error: credsError } = await adminSupabase.from(
      "webauthn_credentials",
    ).select("credential_id, transports").eq("user_id", userId);

    if (credsError) {
      throw credsError;
    }

    if (!credentials || credentials.length === 0) {
      return c.json({ error: "No passkeys registered for this account" }, 404);
    }

    const { origin, rpId } = getRpConfig();
    const challenge = generateChallenge();
    await storeChallenge(adminSupabase, userId, challenge, "login");

    return c.json({
      challenge,
      rpId,
      origin,
      timeout: 60_000,
      allowCredentials: credentials.map((cred: any) => ({
        type: "public-key",
        id: cred.credential_id,
        transports: cred.transports || [],
      })),
      userVerification: "preferred",
    }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[webauthn] login/options failed:", err);
    return c.json({ error: "Failed to start passkey sign-in" }, 500);
  }
});

/**
 * POST /login/verify - verify passkey assertion and mint session (public)
 */
webauthnRouter.post("/login/verify", async (c) => {
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const payload = LoginVerifySchema.parse(body);
    const { origin, rpId } = getRpConfig();

    const tokenPayload = await verify2FAChallengeToken(
      payload.tempToken,
      payload.userId,
    );
    if (!tokenPayload) {
      return c.json(
        { error: "Login challenge expired. Please log in again." },
        401,
      );
    }

    const { data: profile } = await adminSupabase.from("profiles").select("*")
      .eq("id", payload.userId).maybeSingle();
    if (!profile || profile.is_2fa_enabled !== true) {
      return c.json({
        error: "Two-factor authentication is not enabled for this account",
      }, 400);
    }

    const lockout = evaluate2FALockout(profile);
    if (lockout.locked) {
      return c.json(lockoutError(lockout), 429);
    }

    if (profile.two_factor_challenge_nonce !== tokenPayload.nonce) {
      return c.json({
        error: "Login challenge is invalid. Please log in again.",
      }, 401);
    }

    const { data: credential, error: credError } = await adminSupabase.from(
      "webauthn_credentials",
    ).select("id, public_key, counter").eq("user_id", payload.userId)
      .eq("credential_id", payload.credentialId).maybeSingle();

    if (credError || !credential) {
      await register2FAFailure(adminSupabase, payload.userId);
      return c.json({
        error: "Unknown passkey. Try another authentication method.",
      }, 401);
    }

    const { data: pending } = await adminSupabase.from("webauthn_challenges")
      .select("challenge").eq("user_id", payload.userId).eq("purpose", "login")
      .eq("used", false).order("created_at", { ascending: false }).limit(1)
      .maybeSingle();

    if (!pending) {
      return c.json(
        { error: "Passkey sign-in expired. Please try again." },
        400,
      );
    }

    const clientData = await (async () => {
      try {
        const bytes = base64UrlDecode(payload.clientDataJSON);
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return parsed as { type: string; challenge: string; origin: string };
      } catch {
        return null;
      }
    })();
    if (
      !clientData ||
      clientData.type !== "webauthn.get" ||
      clientData.challenge !== pending.challenge ||
      clientData.origin !== origin
    ) {
      await register2FAFailure(adminSupabase, payload.userId);
      return c.json({ error: "Passkey verification failed. Try again." }, 401);
    }

    try {
      const result = await verifyAssertion({
        credentialPublicKey: base64UrlDecode(credential.public_key),
        storedCounter: credential.counter,
        authenticatorData: base64UrlDecode(payload.authenticatorData),
        clientDataJSON: base64UrlDecode(payload.clientDataJSON),
        signature: base64UrlDecode(payload.signature),
      });

      // RP id hash check
      const rpIdHashHex = Array.from(
        base64UrlDecode(payload.authenticatorData).slice(0, 32),
      ).map((b) => b.toString(16).padStart(2, "0")).join("");
      const expectedRpIdHash = await sha256Hex(new TextEncoder().encode(rpId));
      if (rpIdHashHex !== expectedRpIdHash) {
        throw new Error("RP id hash mismatch");
      }

      await consumeChallenge(
        adminSupabase,
        payload.userId,
        "login",
        pending.challenge,
      );
      await adminSupabase.from("webauthn_credentials").update({
        counter: result.signCount,
        last_used_at: new Date().toISOString(),
      }).eq("id", credential.id);

      // Single-use login nonce consumed + guard reset
      await reset2FAGuard(adminSupabase, payload.userId, null);

      const userPayload = await mintSessionFor2FAUser(
        supabaseUrl,
        serviceRoleKey,
        payload.userId,
      );
      return c.json(userPayload, 200);
    } catch (verifyErr: any) {
      console.error("[webauthn] login/verify assertion failed:", verifyErr);
      await register2FAFailure(adminSupabase, payload.userId);
      const message = verifyErr instanceof Error
        ? verifyErr.message
        : "Verification failed";
      return c.json({ error: `Passkey verification failed: ${message}` }, 401);
    }
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[webauthn] login/verify failed:", err);
    return c.json({ error: "Passkey sign-in failed" }, 500);
  }
});

/**
 * POST /passkeys/remove - delete a registered passkey (authenticated)
 */
webauthnRouter.post("/passkeys/remove", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const body = await c.req.json();
    const { credentialId } = PasskeyRemoveSchema.parse(body);

    const { data: deleted, error: deleteError } = await adminSupabase.from(
      "webauthn_credentials",
    ).delete().eq("user_id", user.id).eq("credential_id", credentialId)
      .select("id");

    if (deleteError) {
      throw deleteError;
    }
    if (!deleted || deleted.length === 0) {
      return c.json({ error: "Passkey not found" }, 404);
    }

    const { data: remaining } = await adminSupabase.from(
      "webauthn_credentials",
    ).select("id").eq("user_id", user.id).limit(1);

    const { data: profile } = await adminSupabase.from("profiles").select(
      "two_factor_methods",
    ).eq("id", user.id).maybeSingle();
    const methods: string[] = Array.isArray(profile?.two_factor_methods)
      ? profile.two_factor_methods
      : [];
    const withoutBiometric = methods.filter((m) => m !== "biometric");

    const update: Record<string, unknown> = {
      two_factor_methods: withoutBiometric,
    };
    if (!remaining || remaining.length === 0) {
      update.biometric_enrolled = false;
      update.two_factor_methods = withoutBiometric;
      update.is_2fa_enabled = withoutBiometric.length > 0;
    }
    await adminSupabase.from("profiles").update(update).eq("id", user.id);

    return c.json({ success: true }, 200);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return c.json(
        { error: err.errors[0]?.message || "Validation error" },
        400,
      );
    }
    console.error("[webauthn] passkey removal failed:", err);
    return c.json({ error: "Failed to remove passkey" }, 500);
  }
});
