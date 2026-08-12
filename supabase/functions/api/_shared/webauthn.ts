/**
 * WebAuthn (passkey) verification utilities — zero external dependencies.
 *
 * Implements the subset of the WebAuthn Level 2 / CTAP2 spec needed for
 * platform passkeys (Face ID, Touch ID, Windows Hello) and roaming
 * security keys (YubiKey) with ES256 (COSE alg -7, P-256 ECDSA):
 *
 *  - Registration: CBOR-decode the attestation object, extract the
 *    credential id + COSE public key, verify the client data and (for
 *    `packed`) the attestation signature.
 *  - Authentication: verify the assertion signature over
 *    `authenticatorData || SHA-256(clientDataJSON)` with the stored public
 *    key, check the RP id hash and user-presence flag, and enforce sign
 *    counter monotonicity (credential clone detection).
 */

const ES256_COSE_ALG = -7;
const EC2_KEY_TYPE = 2;
const P256_CRV = 1;

// ============================================================
// Base64URL helpers
// ============================================================

export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ============================================================
// Minimal CBOR decoder (RFC 8949) — sufficient for WebAuthn payloads
// ============================================================

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>;

export function decodeCbor(buffer: Uint8Array): CborValue {
  let offset = 0;
  const reader = {
    buffer,
    offset,
    readByte() {
      if (reader.offset >= reader.buffer.length) {
        throw new Error("CBOR: unexpected end of input");
      }
      return reader.buffer[reader.offset++];
    },
  };
  const value = decodeItem(reader);
  return value;
}

function decodeItem(reader: {
  buffer: Uint8Array;
  offset: number;
  readByte(): number;
}): CborValue {
  const initial = reader.readByte();
  const majorType = initial >> 5;
  let additionalInfo = initial & 0x1f;

  const readArg = (): number => {
    if (additionalInfo < 24) return additionalInfo;
    if (additionalInfo === 24) return reader.readByte();
    if (additionalInfo === 25) {
      const bytes = [reader.readByte(), reader.readByte()];
      return (bytes[0] << 8) | bytes[1];
    }
    if (additionalInfo === 26) {
      const b = [
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
      ];
      return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    }
    if (additionalInfo === 27) {
      const b = [
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
        reader.readByte(),
      ];
      let value = 0;
      for (const byte of b) value = value * 256 + byte;
      return value;
    }
    throw new Error("CBOR: unsupported additional info");
  };

  switch (majorType) {
    case 0:
      return readArg();
    case 1:
      return -1 - readArg();
    case 2: {
      const length = readArg();
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = reader.readByte();
      return bytes;
    }
    case 3: {
      const length = readArg();
      let text = "";
      for (let i = 0; i < length; i++) {
        text += String.fromCharCode(reader.readByte());
      }
      return text;
    }
    case 4: {
      const length = readArg();
      const items: CborValue[] = [];
      for (let i = 0; i < length; i++) items.push(decodeItem(reader));
      return items;
    }
    case 5: {
      const length = readArg();
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = decodeItem(reader);
        const value = decodeItem(reader);
        map.set(key, value);
      }
      return map;
    }
    case 6:
      // Tag: read and discard the tag, return the tagged value.
      readArg();
      return decodeItem(reader);
    case 7:
      if (additionalInfo === 20) return false;
      if (additionalInfo === 21) return true;
      if (additionalInfo === 22) return null;
      throw new Error("CBOR: unsupported simple/float value");
    default:
      throw new Error(`CBOR: unsupported major type ${majorType}`);
  }
}

// ============================================================
// SHA-256 + random challenge helpers
// ============================================================

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// ============================================================
// Attestation object parsing (registration)
// ============================================================

export interface ParsedCredential {
  fmt: string;
  credentialId: string;
  publicKey: Uint8Array; // raw P-256 public key (x || y), 64 bytes
  signCount: number;
  aaguid: string;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Parses a registration authenticator data blob and returns the parsed
 * credential plus the raw authenticator data.
 */
export function parseAuthenticatorData(
  authData: Uint8Array,
): {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credential?: {
    id: string;
    publicKey: Uint8Array;
    aaguid: string;
  };
} {
  if (authData.length < 37) {
    throw new Error("WebAuthn: authenticator data too short");
  }

  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = readUint32BE(authData, 33);

  let offset = 37;
  let credential: {
    id: string;
    publicKey: Uint8Array;
    aaguid: string;
  } | undefined;

  const hasAttestedData = (flags & 0x40) !== 0; // bit 6: AT
  if (hasAttestedData) {
    if (authData.length < offset + 16 + 2) {
      throw new Error("WebAuthn: attested credential data truncated");
    }
    const aaguidBytes = authData.slice(offset, offset + 16);
    offset += 16;
    const credIdLength = (authData[offset] << 8) | authData[offset + 1];
    offset += 2;
    if (authData.length < offset + credIdLength) {
      throw new Error("WebAuthn: credential id truncated");
    }
    const credentialIdBytes = authData.slice(offset, offset + credIdLength);
    offset += credIdLength;

    const coseKeyBytes = authData.slice(offset);
    const publicKey = extractP256PublicKey(coseKeyBytes);

    credential = {
      id: base64UrlEncode(credentialIdBytes),
      publicKey,
      aaguid: base64UrlEncode(aaguidBytes),
    };
  }

  return { rpIdHash, flags, signCount, credential };
}

/**
 * Extracts the raw P-256 (ES256, COSE key type EC2) public key bytes
 * (x || y, 64 bytes) from a CBOR-encoded COSE public key.
 */
export function extractP256PublicKey(coseKeyBytes: Uint8Array): Uint8Array {
  const coseKey = decodeCbor(coseKeyBytes);
  if (!(coseKey instanceof Map)) {
    throw new Error("WebAuthn: COSE key is not a map");
  }

  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);

  if (kty !== EC2_KEY_TYPE || alg !== ES256_COSE_ALG || crv !== P256_CRV) {
    throw new Error("WebAuthn: only ES256 (P-256) credentials are supported");
  }
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("WebAuthn: COSE key missing x/y coordinates");
  }
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("WebAuthn: P-256 coordinates must be 32 bytes");
  }

  const raw = new Uint8Array(64);
  raw.set(x, 0);
  raw.set(y, 32);
  return raw;
}

/**
 * Parses a registration attestation object (CBOR map) and returns the
 * credential + attestation statement for signature verification.
 */
export function parseAttestationObject(
  attestationObjectBytes: Uint8Array,
): {
  fmt: string;
  attStmt: Map<CborValue, CborValue>;
  authData: Uint8Array;
} {
  const attestation = decodeCbor(attestationObjectBytes);
  if (!(attestation instanceof Map)) {
    throw new Error("WebAuthn: attestation object is not a CBOR map");
  }

  const fmt = attestation.get("fmt");
  const attStmt = attestation.get("attStmt");
  const authData = attestation.get("authData");

  if (typeof fmt !== "string") {
    throw new Error("WebAuthn: attestation object missing format");
  }
  if (!(attStmt instanceof Map) || !(authData instanceof Uint8Array)) {
    throw new Error("WebAuthn: attestation object malformed");
  }

  return { fmt, attStmt, authData };
}

// ============================================================
// Signature verification
// ============================================================

async function importP256PublicKey(
  rawPublicKey: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    rawPublicKey as unknown as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Converts an ASN.1 DER ECDSA signature to raw IEEE P1363 (r || s) form.
 * Returns null when the input is not valid DER.
 */
function derToP1363(
  signature: Uint8Array,
  coordLength = 32,
): Uint8Array | null {
  try {
    if (signature.length < 8 || signature[0] !== 0x30) return null;
    let offset = 2;
    if (signature[1] & 0x80) {
      const lenBytes = signature[1] & 0x7f;
      offset = 2 + lenBytes;
    }
    if (signature[offset] !== 0x02) return null;
    offset += 1;
    const rLength = signature[offset];
    offset += 1;
    const r = signature.slice(offset, offset + rLength);
    offset += rLength;
    if (signature[offset] !== 0x02) return null;
    offset += 1;
    const sLength = signature[offset];
    offset += 1;
    const s = signature.slice(offset, offset + sLength);

    const toCoord = (bytes: Uint8Array): Uint8Array => {
      let trimmed = bytes;
      while (trimmed.length > coordLength && trimmed[0] === 0) {
        trimmed = trimmed.slice(1);
      }
      if (trimmed.length > coordLength) return new Uint8Array(coordLength);
      const out = new Uint8Array(coordLength);
      out.set(trimmed, coordLength - trimmed.length);
      return out;
    };

    const out = new Uint8Array(coordLength * 2);
    out.set(toCoord(r), 0);
    out.set(toCoord(s), coordLength);
    return out;
  } catch {
    return null;
  }
}

async function verifyEcdsaSignature(
  rawPublicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await importP256PublicKey(rawPublicKey);

  // Try raw P1363 (r||s) form first, then ASN.1 DER.
  if (signature.length === 64) {
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new Uint8Array(signature) as unknown as BufferSource,
      new Uint8Array(data),
    );
    if (ok) return true;
  }
  const p1363 = derToP1363(signature);
  if (p1363) {
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new Uint8Array(p1363) as unknown as BufferSource,
      new Uint8Array(data),
    );
    if (ok) return true;
  }
  return false;
}

export interface VerifyAssertionInput {
  credentialPublicKey: Uint8Array;
  storedCounter: number;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

export interface VerifyAssertionResult {
  signCount: number;
}

/**
 * Verifies a WebAuthn authentication assertion. Throws on any failure.
 */
export async function verifyAssertion(
  input: VerifyAssertionInput,
): Promise<VerifyAssertionResult> {
  const { credentialPublicKey, storedCounter } = input;
  const { flags, signCount } = parseAuthenticatorData(input.authenticatorData);

  const userPresent = (flags & 0x01) !== 0;
  if (!userPresent) {
    throw new Error("WebAuthn: user presence flag not set");
  }

  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(input.clientDataJSON)),
  );
  const signedData = new Uint8Array(input.authenticatorData.length + 32);
  signedData.set(input.authenticatorData, 0);
  signedData.set(clientDataHash, input.authenticatorData.length);

  const valid = await verifyEcdsaSignature(
    credentialPublicKey,
    signedData,
    input.signature,
  );
  if (!valid) {
    throw new Error("WebAuthn: assertion signature verification failed");
  }

  // Sign counter must be strictly greater than the stored value (unless the
  // authenticator does not implement counters, i.e. counter == 0).
  if (storedCounter !== 0 && signCount !== 0 && signCount <= storedCounter) {
    throw new Error("WebAuthn: credential sign counter regression detected");
  }

  return { signCount: signCount || 0 };
}

/**
 * Verifies a WebAuthn registration client data + attestation and returns the
 * parsed credential. Supports `none` and `packed` attestation formats;
 * `packed` signatures are verified with the credential's own key
 * (self-attestation), which proves possession of the private key.
 */
export async function verifyRegistration(
  clientDataJSON: Uint8Array,
  attestationObject: Uint8Array,
  expectedChallenge: string,
  expectedOrigin: string,
  rpId: string,
): Promise<ParsedCredential> {
  const clientData = parseClientData(clientDataJSON, "webauthn.create");
  if (clientData.challenge !== expectedChallenge) {
    throw new Error("WebAuthn: registration challenge mismatch");
  }
  if (clientData.origin !== expectedOrigin) {
    throw new Error("WebAuthn: registration origin mismatch");
  }

  const { fmt, attStmt, authData } = parseAttestationObject(attestationObject);
  const parsed = parseAuthenticatorData(authData);
  if (!parsed.credential) {
    throw new Error("WebAuthn: registration missing attested credential data");
  }

  const rpIdHash = await sha256Hex(new TextEncoder().encode(rpId));
  const actualHash = Array.from(parsed.rpIdHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (actualHash !== rpIdHash) {
    throw new Error("WebAuthn: RP id hash mismatch");
  }
  if ((parsed.flags & 0x01) === 0) {
    throw new Error("WebAuthn: user presence flag not set");
  }

  if (fmt === "packed") {
    const sig = attStmt.get("sig");
    if (!(sig instanceof Uint8Array)) {
      throw new Error("WebAuthn: packed attestation missing signature");
    }
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(clientDataJSON)),
    );
    const signedData = new Uint8Array(authData.length + 32);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);
    const valid = await verifyEcdsaSignature(
      parsed.credential.publicKey,
      signedData,
      sig,
    );
    if (!valid) {
      throw new Error("WebAuthn: attestation signature verification failed");
    }
  } else if (fmt !== "none") {
    throw new Error(`WebAuthn: unsupported attestation format "${fmt}"`);
  }

  return {
    fmt,
    credentialId: parsed.credential.id,
    publicKey: parsed.credential.publicKey,
    signCount: parsed.signCount,
    aaguid: parsed.credential.aaguid,
  };
}

// ============================================================
// Client data parsing (shared by register + authenticate)
// ============================================================

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

export function parseClientData(
  clientDataJSON: Uint8Array,
  expectedType: string,
): ClientData {
  let parsed: { type?: string; challenge?: string; origin?: string };
  try {
    parsed = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    throw new Error("WebAuthn: invalid clientDataJSON");
  }
  if (parsed.type !== expectedType) {
    throw new Error(
      `WebAuthn: client data type mismatch (expected ${expectedType})`,
    );
  }
  if (
    typeof parsed.challenge !== "string" || typeof parsed.origin !== "string"
  ) {
    throw new Error("WebAuthn: client data missing challenge or origin");
  }
  return {
    type: parsed.type,
    challenge: parsed.challenge,
    origin: parsed.origin,
  };
}
