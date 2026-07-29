import {
  assert,
  assertEquals,
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
  const token = await generate2FAChallengeToken(userId, "test-secret");
  assert(
    token.includes("."),
    "Challenge token should be formatted as userId.timestamp.hmac",
  );

  const valid = await verify2FAChallengeToken(token, userId, "test-secret");
  assertEquals(valid, true, "Should verify valid challenge token");

  const wrongUser = await verify2FAChallengeToken(
    token,
    "other-user-id",
    "test-secret",
  );
  assertEquals(
    wrongUser,
    false,
    "Should reject challenge token for different user",
  );

  const wrongSecret = await verify2FAChallengeToken(
    token,
    userId,
    "wrong-secret",
  );
  assertEquals(
    wrongSecret,
    false,
    "Should reject challenge token signed with different secret",
  );
});

Deno.test("PIN Code - hashPinCode and verifyPinCode securely hash and verify PINs", async () => {
  const pin = "123456";
  const hash = await hashPinCode(pin);
  assertEquals(hash.length, 64, "SHA-256 hash should be 64 hex characters");

  const valid = await verifyPinCode(pin, hash);
  assertEquals(valid, true, "Should verify correct PIN against its hash");

  const invalid = await verifyPinCode("654321", hash);
  assertEquals(
    invalid,
    false,
    "Should reject incorrect PIN against stored hash",
  );
});
