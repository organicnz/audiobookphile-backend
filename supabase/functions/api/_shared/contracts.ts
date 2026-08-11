/**
 * Contract checks (P1.3)
 *
 * Runs `z.safeParse` shape checks against live endpoint responses and reports
 * each one as `ok | missing | wrong-shape` with a per-check duration. Checks
 * run in-process via the real Hono app (`app.request`), so they exercise the
 * exact production handler + error-envelope pipeline without a deployment URL.
 *
 * All checks below are anonymous (no user token): the auth-wall checks assert
 * that protected routes still reject unauthenticated requests with the
 * standard error envelope, which doubles as an auth regression probe.
 */
import { z } from "npm:zod@3.24.1";
import type { Hono } from "hono";
import type { Variables } from "./types.ts";

const HealthSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
  version: z.string(),
  services: z.object({
    database: z.string(),
    zai: z.string(),
  }),
  tables: z.record(z.string(), z.string()),
});

/** Shape returned by route handlers that catch validation failures directly (e.g. /api/auth/login). */
const ValidationErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
});

/** Standard ApiError envelope serialised by handleApiError. */
const AuthErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  requestId: z.string(),
  timestamp: z.string(),
});

/** Plain `{ error: string }` responses from route handlers (e.g. cover 404). */
const PlainErrorSchema = z.object({
  error: z.string(),
});

type ContractCheck = {
  endpoint: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  expectStatus: number;
  schema: z.ZodType;
};

const contractChecks: ContractCheck[] = [
  {
    endpoint: "/api/health",
    method: "GET",
    expectStatus: 200,
    schema: HealthSchema,
  },
  {
    endpoint: "/api/auth/login",
    method: "POST",
    body: {},
    expectStatus: 400,
    schema: ValidationErrorSchema,
  },
  {
    endpoint: "/api/auth/refresh",
    method: "POST",
    body: {},
    expectStatus: 400,
    schema: ValidationErrorSchema,
  },
  {
    endpoint: "/api/auth/signup",
    method: "POST",
    body: {},
    expectStatus: 403,
    schema: ValidationErrorSchema,
  },
  {
    endpoint: "/api/me",
    method: "GET",
    expectStatus: 401,
    schema: AuthErrorSchema,
  },
  {
    endpoint: "/api/admin/analytics",
    method: "GET",
    expectStatus: 401,
    schema: AuthErrorSchema,
  },
  {
    endpoint: "/api/users",
    method: "GET",
    expectStatus: 401,
    schema: AuthErrorSchema,
  },
  {
    endpoint: "/api/items/nonexistent-id/cover",
    method: "GET",
    expectStatus: 404,
    schema: PlainErrorSchema,
  },
];

export type ContractResult = {
  endpoint: string;
  method: string;
  status: number;
  shape: "ok" | "missing" | "wrong-shape";
  ms: number;
};

export async function runContractChecks(
  app: Hono<{ Variables: Variables }>,
): Promise<ContractResult[]> {
  const results: ContractResult[] = [];

  for (const check of contractChecks) {
    const start = Date.now();
    let status = 0;
    let shape: ContractResult["shape"] = "wrong-shape";

    try {
      const res = await app.request(check.endpoint, {
        method: check.method,
        // x-contract-check prevents the nested /api/health check from
        // recursing into runContractChecks.
        headers: {
          "x-contract-check": "1",
          ...(check.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(check.body !== undefined
          ? { body: JSON.stringify(check.body) }
          : {}),
      });
      status = res.status;
      const text = await res.text();

      if (
        status === 404 &&
        text.includes("Endpoint not found or method not supported")
      ) {
        // Router fallback: this endpoint+method is not mounted at all.
        shape = "missing";
      } else if (status === check.expectStatus && text) {
        const parsed = check.schema.safeParse(JSON.parse(text));
        shape = parsed.success ? "ok" : "wrong-shape";
      } else {
        shape = "wrong-shape";
      }
    } catch {
      // Non-JSON/unparseable body or thrown request — report wrong-shape.
      shape = "wrong-shape";
    }

    results.push({
      endpoint: check.endpoint,
      method: check.method,
      status,
      shape,
      ms: Date.now() - start,
    });
  }

  return results;
}
