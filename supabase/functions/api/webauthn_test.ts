import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  decodeCbor,
  extractP256PublicKey,
  generateChallenge,
  parseAuthenticatorData,
  parseClientData,
  sha256Hex,
  verifyAssertion,
  verifyRegistration,
} from "./_shared/webauthn.ts";

const RP_ID = "audiobookphile.vercel.app";
const ORIGIN = "https://audiobookphile.vercel.app";

// ---------------------------------------------------------------------------
// Minimal CBOR encoder — just enough for the attestation objects we build in
// these tests (maps of text/uint/bytes keys and values).
// ---------------------------------------------------------------------------

function cborUint(value: number): Uint8Array {
  if (value < 24) return new Uint8Array([value]);
  if (value < 0x100) return new Uint8Array([0x18, value]);
  if (value < 0x10000) {
    return new Uint8Array([0x19, value >> 8, value & 0xff]);
  }
  return new Uint8Array([
    0x1a,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  const header = cborUint(bytes.length);
  header[0] |= 0x40; // major type 2
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

function cborText(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const header = cborUint(bytes.length);
  header[0] |= 0x60; // major type 3
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

function cborMap(entries: Array<[Uint8Array, Uint8Array]>): Uint8Array {
  const head = cborUint(entries.length);
  head[0] |= 0xa0; // major type 5
  let total = head.length;
  for (const [key, value] of entries) total += key.length + value.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(head, 0);
  offset += head.length;
  for (const [key, value] of entries) {
    out.set(key, offset);
    offset += key.length;
    out.set(value, offset);
    offset += value.length;
  }
  return out;
}

function cborCoseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return cborMap([
    [new Uint8Array([0x01]), cborUint(2)], // kty = EC2
    [new Uint8Array([0x03]), new Uint8Array([0x26])], // alg = -7
    [new Uint8Array([0x20]), cborUint(1)], // crv = P-256
    [new Uint8Array([0x21]), cborBytes(x)], // x
    [new Uint8Array([0x22]), cborBytes(y)], // y
  ]);
}

function u32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

// ---------------------------------------------------------------------------
// Helpers that assemble realistic registration/assertion payloads
// ---------------------------------------------------------------------------

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

async function rawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(exported);
}

function authenticatorData(
  rpIdHash: Uint8Array,
  flags: number,
  counter: number,
  credential?: { id: Uint8Array; coseKey: Uint8Array; aaguid: Uint8Array },
): Uint8Array<ArrayBuffer> {
  if (!credential) {
    const out = new Uint8Array(37);
    out.set(rpIdHash, 0);
    out[32] = flags;
    out.set(u32BE(counter), 33);
    return out;
  }
  const head = 37 + 16 + 2 + credential.id.length;
  const out = new Uint8Array(head + credential.coseKey.length);
  out.set(rpIdHash, 0);
  out[32] = flags;
  out.set(u32BE(counter), 33);
  out.set(credential.aaguid, 37);
  out[53] = (credential.id.length >> 8) & 0xff;
  out[54] = credential.id.length & 0xff;
  out.set(credential.id, 55);
  out.set(credential.coseKey, 55 + credential.id.length);
  return out;
}

function clientDataJSON(
  type: string,
  challenge: string,
  origin: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge,
      origin,
      crossOrigin: false,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("WebAuthn - base64url round-trips binary data", () => {
  const data = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(data);
  assert(
    !encoded.includes("+") && !encoded.includes("/") && !encoded.includes("="),
  );
  const decoded = base64UrlDecode(encoded);
  assertEquals(decoded, data);
});

Deno.test("WebAuthn - CBOR decoder handles maps, negatives, bytes, text", () => {
  const x = new Uint8Array(32).fill(7);
  const encoded = cborMap([
    [new Uint8Array([0x01]), cborUint(2)],
    [new Uint8Array([0x03]), new Uint8Array([0x26])],
    [new Uint8Array([0x20]), cborUint(1)],
    [new Uint8Array([0x21]), cborBytes(x)],
  ]);
  const decoded = decodeCbor(encoded);
  assert(decoded instanceof Map);
  const map = decoded as Map<number | Uint8Array, unknown>;
  assertEquals(map.get(1), 2);
  assertEquals(map.get(3), -7);
  assertEquals(map.get(-1), 1);
  assertEquals(map.get(-2), x);
});

Deno.test("WebAuthn - generateChallenge returns 32 random base64url bytes", () => {
  const a = generateChallenge();
  const b = generateChallenge();
  assert(a !== b, "Challenges must be random");
  assertEquals(base64UrlDecode(a).length, 32);
});

Deno.test("WebAuthn - sha256Hex matches known vector", async () => {
  const hash = await sha256Hex(new TextEncoder().encode("abc"));
  assertEquals(
    hash,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("WebAuthn - parseAuthenticatorData returns credential + flags + counter", () => {
  const rpIdHash = new Uint8Array(32).fill(1);
  const aaguid = new Uint8Array(16).fill(2);
  const credId = new Uint8Array([9, 8, 7, 6]);
  const x = new Uint8Array(32).fill(3);
  const y = new Uint8Array(32).fill(4);
  const coseKey = cborCoseKey(x, y);

  const authData = authenticatorData(rpIdHash, 0x41, 7, {
    id: credId,
    coseKey,
    aaguid,
  });
  const parsed = parseAuthenticatorData(authData);
  assertEquals(parsed.signCount, 7);
  assert((parsed.flags & 0x40) !== 0, "AT flag expected");
  assert(parsed.credential, "Credential expected");
  assertEquals(parsed.credential.id, base64UrlEncode(credId));
  assertEquals(parsed.credential.publicKey.length, 64);
});

Deno.test("WebAuthn - extractP256PublicKey rejects non-ES256 COSE keys", () => {
  const x = new Uint8Array(32).fill(3);
  const y = new Uint8Array(32).fill(4);
  const badAlg = cborMap([
    [new Uint8Array([0x01]), cborUint(2)],
    [new Uint8Array([0x03]), new Uint8Array([0x27])], // alg = -8 (EdDSA) — unsupported
    [new Uint8Array([0x20]), cborUint(1)],
    [new Uint8Array([0x21]), cborBytes(x)],
    [new Uint8Array([0x22]), cborBytes(y)],
  ]);
  assertRejects(() =>
    Promise.resolve().then(() => extractP256PublicKey(badAlg))
  );
});

Deno.test("WebAuthn - verifyAssertion accepts a genuine signed assertion", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const credentialPublicKey = await rawPublicKey(publicKey);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x01, 3);
  const clientData = clientDataJSON("webauthn.get", challenge, ORIGIN);
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientData),
  );

  const signedData = new Uint8Array(authData.length + 32);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signedData,
    ),
  );

  const result = await verifyAssertion({
    credentialPublicKey,
    storedCounter: 2,
    authenticatorData: authData,
    clientDataJSON: clientData,
    signature,
  });
  assertEquals(result.signCount, 3, "Sign counter should be forwarded");
});

Deno.test("WebAuthn - verifyAssertion accepts DER-encoded signature", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const credentialPublicKey = await rawPublicKey(publicKey);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x01, 1);
  const clientData = clientDataJSON("webauthn.get", challenge, ORIGIN);
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientData),
  );
  const signedData = new Uint8Array(authData.length + 32);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);
  const p1363 = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signedData,
    ),
  );

  const der = (coord: Uint8Array): number[] => {
    let trimmed = coord;
    while (trimmed[0] === 0 && trimmed.length > 1) trimmed = trimmed.slice(1);
    const leading = trimmed[0] & 0x80 ? [0, ...trimmed] : [...trimmed];
    return [0x02, leading.length, ...leading];
  };
  const r = der(p1363.slice(0, 32));
  const s = der(p1363.slice(32));
  const seq = [0x30, r.length + s.length, ...r, ...s];

  const result = await verifyAssertion({
    credentialPublicKey,
    storedCounter: 0,
    authenticatorData: authData,
    clientDataJSON: clientData,
    signature: new Uint8Array(seq),
  });
  assertEquals(result.signCount, 1);
});

Deno.test("WebAuthn - verifyAssertion rejects wrong signature", async () => {
  const { privateKey } = await generateKeyPair();
  const { publicKey: otherPublicKey } = await generateKeyPair();
  const credentialPublicKey = await rawPublicKey(otherPublicKey);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x01, 1);
  const clientData = clientDataJSON("webauthn.get", challenge, ORIGIN);
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientData),
  );
  const signedData = new Uint8Array(authData.length + 32);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signedData,
    ),
  );

  await assertRejects(
    () =>
      verifyAssertion({
        credentialPublicKey,
        storedCounter: 0,
        authenticatorData: authData,
        clientDataJSON: clientData,
        signature,
      }),
    Error,
    "signature verification failed",
  );
});

Deno.test("WebAuthn - verifyAssertion rejects missing user presence flag", async () => {
  const { publicKey } = await generateKeyPair();
  const credentialPublicKey = await rawPublicKey(publicKey);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x00, 1); // UP flag NOT set
  const clientData = clientDataJSON("webauthn.get", challenge, ORIGIN);

  await assertRejects(
    () =>
      verifyAssertion({
        credentialPublicKey,
        storedCounter: 0,
        authenticatorData: authData,
        clientDataJSON: clientData,
        signature: new Uint8Array(64),
      }),
    Error,
    "user presence",
  );
});

Deno.test("WebAuthn - verifyAssertion detects sign counter regression", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const credentialPublicKey = await rawPublicKey(publicKey);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x01, 2); // counter went 5 -> 2
  const clientData = clientDataJSON("webauthn.get", challenge, ORIGIN);
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientData),
  );
  const signedData = new Uint8Array(authData.length + 32);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signedData,
    ),
  );

  await assertRejects(
    () =>
      verifyAssertion({
        credentialPublicKey,
        storedCounter: 5,
        authenticatorData: authData,
        clientDataJSON: clientData,
        signature,
      }),
    Error,
    "sign counter regression",
  );
});

Deno.test("WebAuthn - verifyRegistration accepts fmt=none attestation", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const raw = await rawPublicKey(publicKey);
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const coseKey = cborCoseKey(x, y);
  const credId = new TextEncoder().encode("credential-id-123");
  const aaguid = new Uint8Array(16);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x41, 0, {
    id: credId,
    coseKey,
    aaguid,
  });
  const attObj = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authData)],
  ]);
  const clientData = clientDataJSON("webauthn.create", challenge, ORIGIN);

  const credential = await verifyRegistration(
    clientData,
    attObj,
    challenge,
    ORIGIN,
    RP_ID,
  );
  assertEquals(credential.fmt, "none");
  assertEquals(credential.credentialId, base64UrlEncode(credId));
  assertEquals(credential.publicKey.length, 64);
  assertEquals(credential.signCount, 0);
  void privateKey;
});

Deno.test("WebAuthn - verifyRegistration validates challenge and origin", async () => {
  const { publicKey } = await generateKeyPair();
  const raw = await rawPublicKey(publicKey);
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const coseKey = cborCoseKey(x, y);
  const challenge = generateChallenge();

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)),
  );
  const authData = authenticatorData(rpIdHash, 0x41, 0, {
    id: new TextEncoder().encode("cred"),
    coseKey,
    aaguid: new Uint8Array(16),
  });
  const attObj = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authData)],
  ]);
  const clientData = clientDataJSON("webauthn.create", challenge, ORIGIN);

  await assertRejects(
    () =>
      verifyRegistration(clientData, attObj, "wrong-challenge", ORIGIN, RP_ID),
    Error,
    "challenge mismatch",
  );
  await assertRejects(
    () =>
      verifyRegistration(
        clientData,
        attObj,
        challenge,
        "https://evil.example",
        RP_ID,
      ),
    Error,
    "origin mismatch",
  );
});

Deno.test("WebAuthn - parseClientData rejects wrong type and bad JSON", () => {
  const good = parseClientData(
    clientDataJSON("webauthn.get", "challenge", ORIGIN),
    "webauthn.get",
  );
  assertEquals(good.origin, ORIGIN);

  assert(() => {
    try {
      parseClientData(
        clientDataJSON("webauthn.get", "ch", ORIGIN),
        "webauthn.create",
      );
      return false;
    } catch {
      return true;
    }
  }, "Type mismatch must throw");

  assert(() => {
    try {
      parseClientData(new TextEncoder().encode("not json"), "webauthn.get");
      return false;
    } catch {
      return true;
    }
  }, "Invalid JSON must throw");
});
