/**
 * OpenAPI infrastructure (schema-first API)
 *
 * Every route in the API is declared as an OpenAPI route (`createRoute`) with
 * zod request/response schemas, registered on an `OpenAPIHono` router. The
 * resulting OpenAPI document (see scripts/generate_openapi.ts) is the single
 * source of truth consumed by:
 *   - post-deploy verification: Schemathesis fuzz-tests every declared
 *     endpoint against its schema (edge cases, malformed payloads, wrong
 *     types) with zero hand-written cases;
 *   - the Hurl smoke suite and Deno E2E assertions;
 *   - API documentation and future typed clients (openapi-fetch).
 *
 * Request validation runs through `defaultHook`, which preserves the legacy
 * flat `{ error, code }` 400 envelope the clients already parse instead of
 * zod-openapi's default nested `{ error: { ... } }` shape. Handlers keep
 * their original zod parses untouched, so migration risk stays at zero.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { Variables } from "./types.ts";

export { z };

/**
 * Escape hatch for multi-status handlers: the schema-typed context infers a
 * per-route response union that `c.json()` unions cannot satisfy for handlers
 * returning several different statuses. A loosely-typed context makes
 * `c.json` return plain `Response` — still fully validated at runtime by the
 * zod-openapi hook, just without per-status compile-time checking.
 */
export type LooseContext = Context<any, any, any>;

/** Context type for schema-first handlers (see routes/*.ts). */
export type ApiContext = Context<{ Variables: Variables }>;

/**
 * Creates an OpenAPI-enabled Hono router whose request validation failures
 * are serialised exactly like the pre-migration handlers did:
 * `400 { error: <first issue message>, code: "VALIDATION_ERROR" }`.
 */
export function createOpenApiRouter() {
  return new OpenAPIHono<{ Variables: Variables }>({
    defaultHook: (result, c: Context<{ Variables: Variables }>) => {
      if (!result.success) {
        const message = result.error?.issues?.[0]?.message ||
          "Validation error";
        return c.json({ error: message, code: "VALIDATION_ERROR" }, 400);
      }
    },
  });
}

// === Shared response schemas ==============================================
// These are what Schemathesis validates live responses against, so they must
// match the payload builders exactly (see _shared/payloads.ts).

/** Flat validation/auth error envelope used by the auth-family routes. */
export const FlatErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
});

/** Generic `{ success: true, ... }` confirmation payload. */
export const SuccessSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

/** Standard ApiError envelope serialised by handleApiError (index.ts). */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
    validationErrors: z.array(z.unknown()).optional(),
  }),
  requestId: z.string(),
  timestamp: z.string(),
});

/** User payload built by buildUserPayload — returned by all auth endpoints. */
export const UserPayloadSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
    email: z.string().nullable().optional(),
    type: z.string(),
    token: z.string(),
    refreshToken: z.string().nullable().optional(),
    mediaProgress: z.array(z.unknown()),
    seriesHideFromContinueListening: z.array(z.unknown()),
    bookmarks: z.array(z.unknown()),
    isActive: z.boolean(),
    isLocked: z.boolean(),
    lastSeen: z.number(),
    createdAt: z.number(),
    permissions: z.object({
      download: z.boolean(),
      update: z.boolean(),
      delete: z.boolean(),
      upload: z.boolean(),
      accessAllLibraries: z.boolean(),
      accessAllTags: z.boolean(),
      accessExplicitContent: z.boolean(),
    }),
    librariesAccessible: z.array(z.unknown()),
    itemTagsAccessible: z.array(z.unknown()),
  }),
  userDefaultLibraryId: z.string().nullable().optional(),
  serverSettings: z.record(z.unknown()),
  source: z.string(),
});

/** 2FA challenge issued by login when the account has 2FA enabled. */
export const TwoFactorChallengeSchema = z.object({
  requires2FA: z.literal(true),
  userId: z.string(),
  email: z.string().nullable().optional(),
  tempToken: z.string(),
  methods: z.object({
    totp: z.boolean(),
    pin: z.boolean(),
    biometric: z.boolean(),
  }),
});

/** Login may answer with either a full session payload or a 2FA challenge. */
export const LoginResponseSchema = z.union([
  UserPayloadSchema,
  TwoFactorChallengeSchema,
]);

/** Contract-check entry emitted by /api/health (see _shared/contracts.ts). */
export const ContractResultSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  status: z.number(),
  shape: z.enum(["ok", "missing", "wrong-shape"]),
  ms: z.number(),
});

/** /api/health response shape. */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
  version: z.string(),
  services: z.object({
    database: z.string(),
    zai: z.string(),
  }),
  tables: z.record(z.string(), z.string()),
  contracts: z.array(ContractResultSchema),
});
