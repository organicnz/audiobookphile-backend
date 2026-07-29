import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { app } from "./index.ts";

Deno.test("Security Lockdown: POST /api/auth/signup returns 403 SIGNUP_DISABLED", async () => {
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "unauthorized@example.com",
      password: "secretPassword123!",
    }),
  });

  const res = await app.request(req);
  const json = await res.json();

  assertEquals(res.status, 403);
  assertEquals(json.code, "SIGNUP_DISABLED");
  assertEquals(
    json.error,
    "Public registration is disabled. Please contact an administrator for an invitation.",
  );
});

Deno.test("Security Lockdown: POST /api/auth/invite requires admin authorization", async () => {
  const req = new Request("http://localhost/api/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "newmember@example.com",
      role: "user",
    }),
  });

  const res = await app.request(req);
  const json = await res.json();

  // Without a valid admin token, the endpoint must reject with 401 Unauthorized
  assertEquals(res.status, 401);
  assertEquals(json.error.code, "UNAUTHORIZED");
});

Deno.test("Magic Link: POST /api/auth/magic-link is accessible and validates email", async () => {
  const req = new Request("http://localhost/api/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "invalid-email-format",
    }),
  });

  const res = await app.request(req);
  const json = await res.json();

  // Route is reachable (not blocked by 403 SIGNUP_DISABLED) and runs Zod validation
  assertEquals(res.status, 400);
  assertEquals(json.code, "VALIDATION_ERROR");
});
