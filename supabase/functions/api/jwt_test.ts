import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SignJWT } from "jose";
import { verifyJWT } from "./_shared/auth.ts";

const TEST_SECRET = "test-secret-0123456789abcdef";

function encodeB64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.test("verifyJWT: accepts a token signed with the project secret", async () => {
  Deno.env.set("SUPABASE_JWT_SECRET", TEST_SECRET);
  const token = await new SignJWT({ sub: "user-123", email: "a@b.c" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode(TEST_SECRET));

  const payload = await verifyJWT(token);
  assertEquals(payload?.sub, "user-123");
});

Deno.test("verifyJWT: rejects a forged token with no signature", async () => {
  Deno.env.set("SUPABASE_JWT_SECRET", TEST_SECRET);
  const forged = `${
    encodeB64url(JSON.stringify({ alg: "none", typ: "JWT" }))
  }.${
    encodeB64url(
      JSON.stringify({ sub: "victim-uuid", email: "victim@x.io" }),
    )
  }.`;

  const payload = await verifyJWT(forged);
  assertEquals(payload, null);
});

Deno.test("verifyJWT: rejects a token signed with a different secret", async () => {
  Deno.env.set("SUPABASE_JWT_SECRET", TEST_SECRET);
  const token = await new SignJWT({ sub: "user-123" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode("wrong-secret"));

  const payload = await verifyJWT(token);
  assertEquals(payload, null);
});

Deno.test("verifyJWT: rejects a tampered payload (signature no longer matches)", async () => {
  Deno.env.set("SUPABASE_JWT_SECRET", TEST_SECRET);
  const valid = await new SignJWT({ sub: "user-123" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode(TEST_SECRET));

  const [header, , sig] = valid.split(".");
  const tamperedPayload = encodeB64url(JSON.stringify({ sub: "admin-uuid" }));
  const tampered = `${header}.${tamperedPayload}.${sig}`;

  const payload = await verifyJWT(tampered);
  assertEquals(payload, null);
});

Deno.test("verifyJWT: fails closed when the secret is not configured", async () => {
  Deno.env.delete("SUPABASE_JWT_SECRET");
  const token = await new SignJWT({ sub: "user-123" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode(TEST_SECRET));

  const payload = await verifyJWT(token);
  assertEquals(payload, null);
});
