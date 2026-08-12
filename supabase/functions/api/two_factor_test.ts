import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  generate2FAChallengeToken,
  generateTotpCode,
  generateTotpSecret,
  generateTotpUri,
  hashPinCode,
  verify2FAChallengeToken,
  verifyPinCode,
  verifyTotpCode,
} from "./_shared/totp.ts";
import {
  evaluate2FALockout,
  lockoutError,
  MAX_2FA_FAILED_ATTEMPTS,
} from "./_shared/twoFactorGuard.ts";

Deno.test("TOTP - generateTotpSecret produces base32 valid string", () => {
  const secret = generateTotpSecret(20);
  assert(secret.length > 0, "Secret should not be empty");
  assert(
    /^[A-Z2-7]+$/.test(secret),
    "Secret should contain only Base32 characters",
  );
});

Deno.test("TOTP - generateTotpUri formats standard otpauth:// URI", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const uri = generateTotpUri(secret, "test@example.com", "Audiobookphile");
  assert(
    uri.startsWith("otpauth://totp/Audiobookphile:test%40example.com"),
    "Should format account correctly",
  );
  assert(uri.includes("secret=JBSWY3DPEHPK3PXP"), "Should include secret");
  assert(uri.includes("period=30"), "Should include period=30");
});

Deno.test("TOTP - generateTotpCode and verifyTotpCode match at current timestamp", async () => {
  const secret = generateTotpSecret(20);
  const now = Date.now();
  const code = await generateTotpCode(secret, now);
  assertEquals(code.length, 6, "Code must be 6 digits");

  const valid = await verifyTotpCode(secret, code, 1, now);
  assertEquals(valid, true, "Generated code should verify successfully");

  const invalid = await verifyTotpCode(secret, "000000", 0, now);
  assertEquals(invalid, false, "Zero code should fail verification");
  // Extremely unlikely 000000 happens to be the code, but check against a mutated code
  const mutatedCode = (parseInt(code, 10) + 1).toString().padStart(6, "0");
  const validMutated = await verifyTotpCode(secret, mutatedCode, 0, now);
  assertEquals(validMutated, false, "Wrong code should fail verification");
});

Deno.test("TOTP - verifyTotpCode allows +/- 1 time step window", async () => {
  const secret = generateTotpSecret(20);
  const now = Date.now();
  // Code generated 25 seconds in the past should still be valid with window = 1
  const pastCode = await generateTotpCode(secret, now - 25000);
  const validPast = await verifyTotpCode(secret, pastCode, 1, now);
  assertEquals(validPast, true, "Should verify code within window");
});

Deno.test("TOTP - generate2FAChallengeToken and verify2FAChallengeToken validate challenge", async () => {
  const userId = "123e4567-e89b-12d3-a456-426614174000";
  const nonce = "abc-123-nonce";
  const secret = "test-signing-secret";
  const token = await generate2FAChallengeToken(userId, nonce, secret);

  const parts = token.split(".");
  assertEquals(
    parts.length,
    4,
    "Token should be userId.timestamp.nonce.signature",
  );
  assertEquals(parts[0], userId, "First part should be the user id");
  assertEquals(parts[2], nonce, "Third part should be the nonce");

  const payload = await verify2FAChallengeToken(token, userId, secret);
  assert(payload, "Should verify valid challenge token");
  assertEquals(payload.userId, userId);
  assertEquals(
    payload.nonce,
    nonce,
    "Nonce must be recoverable for single-use check",
  );
  assert(
    typeof payload.timestamp === "number" && payload.timestamp > 0,
    "Timestamp must be embedded",
  );

  const wrongUser = await verify2FAChallengeToken(
    token,
    "other-user-id",
    secret,
  );
  assertEquals(
    wrongUser,
    null,
    "Should reject challenge token for different user",
  );

  const wrongSecret = await verify2FAChallengeToken(
    token,
    userId,
    "wrong-secret",
  );
  assertEquals(
    wrongSecret,
    null,
    "Should reject challenge token signed with different secret",
  );
});

Deno.test("TOTP - challenge token rejects tampering and malformed shapes", async () => {
  const userId = "123e4567-e89b-12d3-a456-426614174000";
  const secret = "test-signing-secret";
  const token = await generate2FAChallengeToken(userId, "nonce-1", secret);

  const tamperedSignature = token.slice(0, token.length - 2) + "00";
  const tamperedToken = await verify2FAChallengeToken(
    tamperedSignature,
    userId,
    secret,
  );
  assertEquals(tamperedToken, null, "Tampered signature must be rejected");

  const tamperedNonce = token.split(".").map((p, i) => i === 2 ? "other" : p)
    .join(".");
  const nonceToken = await verify2FAChallengeToken(
    tamperedNonce,
    userId,
    secret,
  );
  assertEquals(nonceToken, null, "Tampered nonce must be rejected");

  assertEquals(
    await verify2FAChallengeToken("", userId, secret),
    null,
    "Empty token must be rejected",
  );
  assertEquals(
    await verify2FAChallengeToken("a.b.c", userId, secret),
    null,
    "3-part token must be rejected",
  );
  assertEquals(
    await verify2FAChallengeToken("a.b.c.d.e", userId, secret),
    null,
    "5-part token must be rejected",
  );
});

Deno.test("TOTP - challenge token expires after max age", async () => {
  const userId = "123e4567-e89b-12d3-a456-426614174000";
  const secret = "test-signing-secret";
  const token = await generate2FAChallengeToken(userId, "nonce-2", secret);

  const expired = await verify2FAChallengeToken(token, userId, secret, -1);
  assertEquals(expired, null, "Negative max-age must reject the token");
});

Deno.test("TOTP - challenge signing fails closed without 2FA_CHALLENGE_SIGNING_KEY", async () => {
  const previous = Deno.env.get("2FA_CHALLENGE_SIGNING_KEY");
  Deno.env.delete("2FA_CHALLENGE_SIGNING_KEY");
  try {
    await assertRejects(
      () => generate2FAChallengeToken("some-user", "nonce"),
      Error,
      "2FA_CHALLENGE_SIGNING_KEY is not configured",
    );
  } finally {
    if (previous !== undefined) {
      Deno.env.set("2FA_CHALLENGE_SIGNING_KEY", previous);
    }
  }
});

Deno.test("2FA guard - evaluate2FALockout exposes attempt budget", () => {
  const fresh = evaluate2FALockout({});
  assertEquals(fresh.locked, false);
  assertEquals(fresh.attemptsRemaining, MAX_2FA_FAILED_ATTEMPTS);

  const afterFailures = evaluate2FALockout({ two_factor_failed_attempts: 3 });
  assertEquals(afterFailures.locked, false);
  assertEquals(afterFailures.attemptsRemaining, MAX_2FA_FAILED_ATTEMPTS - 3);

  const locked = evaluate2FALockout({
    two_factor_failed_attempts: 5,
    two_factor_locked_until: new Date(Date.now() + 10 * 60 * 1000)
      .toISOString(),
  });
  assertEquals(locked.locked, true);
  assert(locked.remainingSeconds > 0, "Remaining seconds must be positive");

  const lockExpired = evaluate2FALockout({
    two_factor_failed_attempts: 5,
    two_factor_locked_until: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  assertEquals(lockExpired.locked, false, "Expired lock must be cleared");
  assertEquals(lockExpired.attemptsRemaining, 0);
});

Deno.test("2FA guard - lockoutError surfaces code and lockout seconds", () => {
  const state = evaluate2FALockout({
    two_factor_failed_attempts: 5,
    two_factor_locked_until: new Date(Date.now() + 10 * 60 * 1000)
      .toISOString(),
  });
  const err = lockoutError(state);
  assertEquals(err.code, "2FA_LOCKED");
  assertEquals(err.locked, true);
  assert(typeof err.lockoutSeconds === "number" && err.lockoutSeconds > 0);
  assert(err.error.includes("locked"));
});

Deno.test("PIN Code - hashPinCode and verifyPinCode securely hash and verify PINs", async () => {
  const pin = "123456";
  const hash = await hashPinCode(pin);
  assertEquals(
    hash.length,
    97,
    "PBKDF2 hash should be 97 chars (32 hex salt + colon + 64 hex hash)",
  );

  const result = await verifyPinCode(pin, hash);
  const valid = result === true || (typeof result === "object" && result.valid);
  assertEquals(valid, true, "Should verify correct PIN against its hash");

  const invalidResult = await verifyPinCode("654321", hash);
  const invalid = invalidResult === true ||
    (typeof invalidResult === "object" && invalidResult.valid);
  assertEquals(
    invalid,
    false,
    "Should reject incorrect PIN against stored hash",
  );
});
