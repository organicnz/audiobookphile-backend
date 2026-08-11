/**
 * Contract-shape checks (P1.3) + alias deprecation log (P2.1)
 *
 * The health endpoint reports per-endpoint zod shape validation against live
 * handler responses: ok | missing | wrong-shape. These tests run the same
 * in-process contract checks the deployed health endpoint runs, against the
 * real Hono app with no database or env required (all checks are anonymous
 * and terminate before any DB call).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import app from "./index.ts";
import { runContractChecks } from "./_shared/contracts.ts";

Deno.test("alias deprecation log fires once per /api path", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => {
    warnings.push(String(msg));
  };

  try {
    await app.request("/api/health", { headers: { "x-contract-check": "1" } });
    const alias = warnings.find((w) => w.includes('"event":"route-alias"'));
    assertEquals(alias !== undefined, true, "alias hit is logged");
    assertEquals(
      alias?.includes('"canonical":"/health"'),
      true,
      "canonical path is recorded",
    );
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("health endpoint with x-contract-check skips nested contracts", async () => {
  const res = await app.request("/api/health", {
    headers: { "x-contract-check": "1" },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.contracts, undefined, "no recursion into contracts");
});

Deno.test("runContractChecks validates every endpoint against its schema", async () => {
  const results = await runContractChecks(app);

  assertEquals(results.length, 8, "all contract checks run");
  for (const check of results) {
    assertEquals(
      check.shape,
      "ok",
      `${check.method} ${check.endpoint} -> ${check.shape} (status ${check.status})`,
    );
    assertEquals(typeof check.ms, "number");
  }
});

Deno.test("health response includes contract results with ok shapes", async () => {
  const res = await app.request("/api/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(Array.isArray(body.contracts), true);
  const shapes = new Set(body.contracts.map((c: { shape: string }) => c.shape));
  assertEquals(shapes.has("ok"), true, "at least one contract ok");
  assertEquals(shapes.has("wrong-shape"), false, "no wrong shapes");
  assertEquals(shapes.has("missing"), false, "no missing endpoints");
});
