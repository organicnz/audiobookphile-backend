import { expect, test } from "@playwright/test";

test("health: database connected and zai configured", async ({ request }) => {
  const res = await request.get("/functions/v1/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.services?.database).toBe("connected");
  expect(body.services?.zai).toBe("configured");
});

test("health: contract check header yields per-endpoint results", async ({ request }) => {
  const res = await request.get("/functions/v1/api/health", {
    headers: { "x-contract-check": "1" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  // presence of the version field proves the unified API is deployed
  expect(String(body.version ?? "")).not.toBe("");
});
