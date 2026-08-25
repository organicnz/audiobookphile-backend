import { expect, test } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  loginUser,
  type TestUser,
} from "./fixtures";

let user: TestUser;

test.beforeAll(async () => {
  user = await createTestUser("e2e-auth");
  user.token = await loginUser(user.email, user.password);
});

test.afterAll(async () => {
  if (user?.id) await deleteTestUser(user.id);
});

test("login rejects wrong password without leaking internals", async ({ request }) => {
  const res = await request.post("/functions/v1/api/auth/login", {
    data: { username: user.email, password: "definitely-wrong-pw" },
  });
  expect([400, 401, 403]).toContain(res.status());
  const body = await res.json();
  const raw = JSON.stringify(body);
  expect(raw.toLowerCase()).not.toContain("supabase");
  expect(raw.toLowerCase()).not.toContain("gotrue");
});

test("login issues a usable session for authenticated calls", async ({ request }) => {
  const res = await request.get("/functions/v1/api/me", {
    headers: { Authorization: `Bearer ${user.token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(String(body.id ?? body.user?.id ?? "")).not.toBe("");
});

test("unauthenticated access to protected route is rejected uniformly", async ({ request }) => {
  const res = await request.get("/functions/v1/api/me");
  expect(res.status()).toBe(401);
});
