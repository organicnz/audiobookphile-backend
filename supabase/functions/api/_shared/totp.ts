/**
 * RFC 6238 Time-Based One-Time Password (TOTP) utility.
 * Implemented using Deno Web Crypto API (crypto.subtle) with zero external dependencies.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encodes a Uint8Array to a Base32 string (RFC 4648 without padding).
 */
export function base32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes a Base32 string to a Uint8Array.
 */
export function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const length = (cleaned.length * 5) >> 3;
  const result = new Uint8Array(length);

  let bits = 0;
  let value = 0;
  let index = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const charValue = BASE32_ALPHABET.indexOf(char);
    if (charValue === -1) continue;

    value = (value << 5) | charValue;
    bits += 5;

    if (bits >= 8) {
      result[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }

  return result;
}

/**
 * Generates a cryptographically random Base32 TOTP secret.
 * Default is 20 bytes (160 bits), standard for RFC 4226 / RFC 6238.
 */
export function generateTotpSecret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/**
 * Generates the standard otpauth:// URI for authenticator apps.
 */
export function generateTotpUri(
  secret: string,
  accountName: string,
  issuer = "Audiobookphile",
): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Computes the 6-digit TOTP code for a given secret and timestamp.
 */
export async function generateTotpCode(
  secret: string,
  timestampMs = Date.now(),
  timeStepSec = 30,
  digits = 6,
): Promise<string> {
  const secretBytes = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / timeStepSec);

  // Convert counter to 8-byte big-endian array
  const counterBytes = new Uint8Array(8);
  let tempCounter = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = tempCounter & 0xff;
    tempCounter = Math.floor(tempCounter / 256);
  }

  // Import key for HMAC-SHA1
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretBytes).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, counterBytes);
  const hmac = new Uint8Array(signature);

  // Dynamic truncation (RFC 4226 Section 5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, "0");
}

/**
 * Verifies a 6-digit TOTP code against the secret within a time window.
 * Default window = 1 checks timeStep - 1, timeStep, timeStep + 1 (+/- 30 sec).
 */
export async function verifyTotpCode(
  secret: string,
  inputCode: string,
  window = 1,
  timestampMs = Date.now(),
): Promise<boolean> {
  if (!secret || !inputCode || inputCode.trim().length !== 6) {
    return false;
  }

  const cleanCode = inputCode.trim();

  for (let i = -window; i <= window; i++) {
    const timeOffset = timestampMs + i * 30000;
    const expected = await generateTotpCode(secret, timeOffset);
    if (cleanCode === expected) {
      return true;
    }
  }

  return false;
}

/**
 * Converts a Uint8Array to a hex string.
 */
export function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two hex strings to prevent timing attacks.
 * Always compares all bytes regardless of where the first mismatch occurs.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Returns the HMAC signing key for 2FA challenge tokens.
 *
 * FAILS CLOSED: if SUPABASE_JWT_SECRET is not configured, no token can be
 * signed or verified. There is deliberately NO fallback constant — a
 * hardcoded signing key would let anyone forge login challenges and bypass
 * two-factor authentication entirely.
 */
function getChallengeSigningKey(): string {
  const secret = Deno.env.get("2FA_CHALLENGE_SIGNING_KEY");
  if (!secret) {
    throw new Error(
      "[2fa] 2FA_CHALLENGE_SIGNING_KEY is not configured — cannot sign 2FA challenges",
    );
  }
  return secret;
}

/**
 * Generates an HMAC-SHA256 signed challenge token for 2FA login verification.
 * The token embeds the user id, a fresh random nonce, and an expiry timestamp:
 *   `userId.timestamp.nonce.hex-signature`
 *
 * The nonce is persisted on the user's profile and consumed on first use,
 * making the token single-use. Valid for 10 minutes by default.
 */
export async function generate2FAChallengeToken(
  userId: string,
  nonce: string,
  secretKey = getChallengeSigningKey(),
): Promise<string> {
  const timestamp = Date.now();
  const payload = `${userId}.${timestamp}.${nonce}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  const hex = bufferToHex(new Uint8Array(signature));

  return `${payload}.${hex}`;
}

/**
 * Verifies an HMAC-SHA256 challenge token for 2FA login.
 *
 * Returns the token payload `{ userId, timestamp, nonce }` when valid, or
 * null when the signature is invalid, the token is expired, or the token
 * belongs to a different user.
 */
export async function verify2FAChallengeToken(
  token: string,
  expectedUserId: string,
  secretKey = getChallengeSigningKey(),
  maxAgeMs = 10 * 60 * 1000, // 10 minutes
): Promise<{ userId: string; timestamp: number; nonce: string } | null> {
  if (!token || !token.includes(".")) return null;

  const parts = token.split(".");
  if (parts.length !== 4) return null; // userId.timestamp.nonce.signature

  const [userId, timestampStr, nonce, providedHex] = parts;
  if (userId !== expectedUserId) return null;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || Date.now() - timestamp > maxAgeMs) {
    return null;
  }

  const payload = `${userId}.${timestamp}.${nonce}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  const expectedHex = bufferToHex(new Uint8Array(signature));

  if (!constantTimeEqual(providedHex, expectedHex)) return null;

  return { userId, timestamp, nonce };
}

// ============================================================
// PIN Code Hashing — PBKDF2 with per-user random salt
// ============================================================

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const PBKDF2_KEY_LENGTH = 32; // 256 bits

/**
 * Hashes a PIN code using PBKDF2 (100K iterations, random 16-byte salt).
 * Returns format: `salt_hex:derived_hex`
 */
export async function hashPinCode(pin: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    PBKDF2_KEY_LENGTH * 8,
  );

  const saltHex = bufferToHex(salt);
  const derivedHex = bufferToHex(new Uint8Array(derivedBits));
  return `${saltHex}:${derivedHex}`;
}

/**
 * Legacy SHA-256 PIN hash (for migration detection only).
 * DO NOT use for new hashes — kept solely to verify old-format PINs.
 */
async function legacyHashPinCode(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`abp_pin_salt_${pin}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies a PIN code against its stored hash.
 *
 * Supports both formats:
 *  - New PBKDF2: `salt_hex:derived_hex` (contains `:`)
 *  - Legacy SHA-256: plain hex string (no `:`)
 *
 * When a legacy hash matches, returns `{ valid: true, rehash: newHash }`
 * so the caller can upgrade the stored hash in the database.
 */
export async function verifyPinCode(
  pin: string,
  hash: string,
): Promise<boolean | { valid: boolean; rehash?: string }> {
  // New PBKDF2 format: salt_hex:derived_hex
  if (hash.includes(":")) {
    const [saltHex, storedDerivedHex] = hash.split(":");
    const salt = new Uint8Array(
      (saltHex.match(/.{2}/g) || []).map((byte) => parseInt(byte, 16)),
    );

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(pin),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: PBKDF2_HASH,
      },
      keyMaterial,
      PBKDF2_KEY_LENGTH * 8,
    );

    const computedHex = bufferToHex(new Uint8Array(derivedBits));
    return constantTimeEqual(computedHex, storedDerivedHex);
  }

  // Legacy SHA-256 format: plain hex (no colon)
  const legacyHash = await legacyHashPinCode(pin);
  if (constantTimeEqual(legacyHash, hash)) {
    // PIN is valid — return new PBKDF2 hash for migration
    const newHash = await hashPinCode(pin);
    return { valid: true, rehash: newHash };
  }

  return false;
}
