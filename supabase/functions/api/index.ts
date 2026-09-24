import { Context, Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Sentry, trackRequestMetrics } from "../_shared/sentry.ts";

// ============================================================================
// OpenAPI Routers
// ============================================================================
import { settingsRouter } from "./routes/settings.ts";
import { debugRouter } from "./routes/debug.ts";
import { metadataRouter } from "./routes/metadata.ts";
import { authorsRouter } from "./routes/authors.ts";
import { usersRouter } from "./routes/users.ts";
import { librariesRouter } from "./routes/libraries.ts";
import { handleChapterAI, itemsRouter } from "./routes/items.ts";
import { playbackRouter } from "./routes/playback.ts";
import { progressRouter } from "./routes/progress.ts";
import { playlistsRouter } from "./routes/playlists.ts";
import { collectionsRouter } from "./routes/collections.ts";
import { authRouter } from "./routes/auth.ts";
import { migrateBatchRouter } from "./routes/migrateBatch.ts";
import { downloadsRouter } from "./routes/downloads.ts";
import { bookmarksRouter } from "./routes/bookmarks.ts";
import { searchRouter } from "./routes/search.ts";
import { meRouter } from "./routes/me.ts";
import { adminRouter } from "./routes/admin.ts";
import { twoFactorRouter } from "./routes/twoFactor.ts";
import { webauthnRouter } from "./routes/webauthn.ts";
import { aiRouter } from "./aiService.ts";
import { sentryRouter } from "./routes/sentry.ts";

import { Variables } from "./_shared/types.ts";
import { ApiError, serviceRoleMiddleware } from "./_shared/errors.ts";
import { authMiddleware } from "./_shared/auth.ts";
import { runContractChecks } from "./_shared/contracts.ts";
import { HealthResponseSchema } from "./_shared/openapi.ts";
import { mountRouter } from "./_shared/router.ts";
import { rateLimitMiddleware } from "./_shared/rate-limit.ts";
import { errorEnvelope, getRequestId, withTimeout } from "./_shared/http.ts";

// Global error listeners — capture errors that escape the Hono middleware chain
// (background tasks, timers, unawaited promises) so they land in Sentry instead
// of silently dying with the isolate. Gated on production like the middleware.
const captureGlobalError = (err: unknown, eventType: string) => {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(`[API] ${eventType}:`, error.message);
  if (Deno.env.get("NODE_ENV") === "production") {
    Sentry.setTag("event_type", eventType);
    Sentry.captureException(error);
    // Fire-and-forget flush; the isolate may be reaped before the default
    // async transport drains.
    Sentry.flush(2000);
  }
};
addEventListener("unhandledrejection", (event) => {
  captureGlobalError(
    event.reason ?? new Error("Unhandled promise rejection"),
    "unhandledrejection",
  );
});
addEventListener("error", (event) => {
  captureGlobalError(
    event.error ?? new Error(event.message ?? "Uncaught error"),
    "uncaught_error",
  );
});

const app = new OpenAPIHono<{ Variables: Variables }>({
  defaultHook: (result, c: Context<{ Variables: Variables }>) => {
    if (!result.success) {
      const message = result.error?.issues?.[0]?.message ||
        "Validation error";
      return c.json(
        {
          error: message,
          code: "VALIDATION_ERROR",
        },
        400,
      );
    }
  },
});

// === MIDDLEWARE CHAIN ===
// Order matters: CORS → health → logging → error handling → auth → service role → routes

// 1. CORS (must run first so preflight OPTIONS requests get proper headers)
// Restricted to the web app, Vercel preview deployments and local dev.
// Canonical domain is audiobookphile.app; the vercel.app/foodshare.club
// entries are legacy fallbacks (vercel.app suffix belongs to the old scope).
// Requests without an Origin header (native apps, cron, curl) are always
// allowed — CORS is a browser enforcement mechanism only.
const ALLOWED_ORIGINS = [
  "https://audiobookphile.app",
  "https://www.audiobookphile.app",
  "https://app.audiobookphile.app",
  "https://api.audiobookphile.app",
  "https://audiobookphile.vercel.app",
  "https://audiobookphile.foodshare.club",
];
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.audiobookphile\.app$/i, // app/www/api subdomains
  /^https:\/\/audiobookphile-[a-z0-9-]+\.vercel\.app$/i, // preview deployments
  /^https:\/\/audiobookphile-[a-z0-9-]+\.foodshare\.club$/i,
  /^http:\/\/localhost:\d+$/i,
  /^http:\/\/127\.0\.0\.1:\d+$/i,
];
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      if (ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin))) return origin;
      return null;
    },
    // x-refresh-token is required for the /authorize silent-refresh path used
    // by the iOS Audiobookshelf client to avoid daily re-authentication prompts.
    allowHeaders: [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "x-refresh-token",
      "x-request-id",
    ],
    exposeHeaders: ["X-Request-ID"],
    maxAge: 86400,
    credentials: true,
  }),
);

// 2. Compression — responses are gzip'd when the client sends
// Accept-Encoding: gzip. Shelf payloads are already slim (list mode drops the
// per-file track metadata), and gzip shrinks the remaining JSON ~10-15x on the
// wire. Must run after CORS so preflight responses stay uncompressed.
app.use("*", compress());

// 2.5 Security Headers (HSTS, X-Frame-Options, Cross-Origin-Resource-Policy)
// Configure CORP to cross-origin so cover images, audio streams and API responses
// can be loaded cross-origin by the web client without ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
app.use(
  "*",
  secureHeaders({
    crossOriginResourcePolicy: "cross-origin",
    crossOriginOpenerPolicy: false,
  }),
);

// 3. Alias deprecation log (P2.1): the canonical paths are the runtime-stripped
// ones (Supabase Edge Runtime removes /functions/v1/api). Log once per
// /api-prefixed alias path so migration off the legacy prefix is observable.
// NOTE: must be registered before any exact /api route — Hono skips path
// middleware registered after an exact-route match for that route.
const aliasPathsSeen = new Set<string>();
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (!aliasPathsSeen.has(path)) {
    aliasPathsSeen.add(path);
    const canonical = path.replace(/^\/api/, "") || "/";
    console.warn(
      JSON.stringify({ level: "warn", event: "route-alias", path, canonical }),
    );
  }
  await next();
});

// 3. Health check (before auth so it's always accessible)
// 30s cache + 2s per-table timeouts keep uptime probes cheap and fast.
const HEALTH_CACHE_MS = 30_000;
const healthCache: {
  at: number;
  payload: { tables: Record<string, string> } | null;
} = {
  at: 0,
  payload: null,
};
const healthDoc = {
  method: "get" as const,
  path: "/api/health",
  tags: ["system"],
  responses: {
    200: {
      description:
        "Service health, database connectivity and API contract status",
      content: {
        "application/json": { schema: HealthResponseSchema },
      },
    },
  },
};
const healthHandler = async (c: Context<{ Variables: Variables }>) => {
  const zaiConfigured = Boolean(
    Deno.env.get("ZAI_API_KEY") || Deno.env.get("ZHIPU_API_KEY"),
  );
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const tables = [
    "profiles",
    "libraries",
    "library_items",
    "media_progress",
    "book_insights",
    "authors",
  ];
  // 30s in-memory cache — /health is polled by uptime monitors and would
  // otherwise fan out 6 DB round trips per probe.
  const now = Date.now();
  const cached = healthCache.payload && (now - healthCache.at < HEALTH_CACHE_MS)
    ? healthCache.payload.tables as Record<string, string>
    : null;
  const tableStatus: Record<string, string> = {};
  if (cached && !c.req.query("fresh")) {
    Object.assign(tableStatus, cached);
  } else if (url && serviceRoleKey) {
    const client = createClient(url, serviceRoleKey);
    await Promise.all(
      tables.map(async (table) => {
        // 2s per-table budget — one slow table must not hang the probe.
        const probe = client.from(table).select("id", {
          count: "exact",
          head: true,
        });
        const res = await withTimeout(
          probe as unknown as Promise<{ error: unknown }>,
          2000,
          `health:${table}`,
        );
        tableStatus[table] = !res ? "timeout" : res.error ? "error" : "ok";
      }),
    );
    healthCache.payload = { tables: { ...tableStatus } };
    healthCache.at = now;
  } else {
    for (const table of tables) tableStatus[table] = "unconfigured";
  }

  // Sentry health check
  const sentryClient = Sentry.getClient();
  const sentryHealthy = Boolean(sentryClient);

  // Optionally send a test event if requested via query param
  let sentryTestEvent: string | undefined;
  if (c.req.query("sentry_test") === "true" && sentryHealthy) {
    try {
      sentryTestEvent = Sentry.captureMessage("Sentry health check", "debug");
    } catch (err) {
      console.error("[Health] Sentry test event failed:", err);
    }
  }

  const payload: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2026.07.24",
    services: {
      database: url && serviceRoleKey ? "connected" : "unconfigured",
      zai: zaiConfigured ? "configured" : "unconfigured",
      sentry: sentryHealthy ? "configured" : "unconfigured",
    },
    tables: tableStatus,
  };

  if (sentryTestEvent) {
    payload.sentryTestEvent = sentryTestEvent;
  }

  // Contract shape checks (P1.3). The nested /api/health check sends
  // x-contract-check so it does not recurse into itself.
  if (c.req.header("x-contract-check") !== "1") {
    payload.contracts = await runContractChecks(app);
  }

  return c.json(payload);
};
app.openapi(healthDoc, healthHandler as any);

// 4. Structured Logging + Request-ID Middleware
// NOTE: `c.res.headers.set()` before `next()` is lost — Hono swaps the
// Response object downstream. The id is stored in context pre-next (so error
// envelopes can read it) and stamped onto the final response via `c.header()`
// post-next, which is the API that survives the swap.
app.use(async (c, next) => {
  const start = Date.now();
  getRequestId(c);
  // Propagate an incoming X-Request-ID (mobile/web tracing) when present.
  const incoming = c.req.header("x-request-id");
  if (incoming && incoming.length <= 128) {
    c.set("requestId", incoming);
  }
  await next();
  c.header("X-Request-ID", c.get("requestId") as string);
  const duration = Date.now() - start;

  // Only log in production
  if (Deno.env.get("NODE_ENV") === "production") {
    const log = {
      level: "info",
      timestamp: new Date().toISOString(),
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      headers: { "x-client-info": c.req.header("x-client-info") },
      statusCode: c.res.status,
      durationMs: duration,
      user: (c.get("user") as { email?: string } | null)?.email,
      ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") ||
        "unknown",
    };
    console.log(JSON.stringify(log));

    // Track API Application Metrics via Sentry (safe: no-ops when uninitialized)
    trackRequestMetrics(c.req.method, c.res.status, duration);
  }
});

// 4b. Rate limiting (in-memory token bucket; fails open, exempts health).
app.use(rateLimitMiddleware);

// 4c. Request timeout — a hung DB/storage call must never pin an isolate.
// 25s stays under the Edge 60s wall while giving slow queries room.
app.use(async (c, next) => {
  const timeoutMs = 25_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);
  try {
    await Promise.race([
      next(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new ApiError("Request timeout", "TIMEOUT", 504)),
          timeoutMs,
        )
      ),
    ]);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      console.warn(
        `[API] request exceeded ${timeoutMs}ms: ${c.req.method} ${c.req.path}`,
      );
    }
  }
});

// 4. Error Handling (Middleware & onError)
// Derives a stable Sentry fingerprint from the error type + first code frame so
// the same underlying bug groups into one issue regardless of request variance.
const buildErrorFingerprint = (err: unknown): string | null => {
  if (!(err instanceof Error)) return null;
  const name = err.name || "Error";
  const stack = (err as Error).stack || "";
  const frame = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /at\s+.+\.ts:\d+/.test(line));
  return frame ? `${name}:${frame}` : name;
};
const handleApiError = async (
  err: unknown,
  c: Context<{ Variables: Variables }>,
) => {
  const apiErr = err as ApiError;
  if (apiErr?.statusCode) {
    return errorEnvelope(
      c,
      apiErr.code || "ERROR",
      apiErr.message || "Request failed",
      apiErr.statusCode,
      {
        ...(apiErr.field ? { field: apiErr.field } : {}),
        ...(apiErr.validationErrors
          ? { validationErrors: apiErr.validationErrors }
          : {}),
      },
    );
  } else if (err instanceof Response && err.status >= 500) {
    return err;
  } else {
    const errorId = crypto.randomUUID();
    console.error(
      `[API Index] Unhandled error [${errorId}] - Request: ${c.req.method} ${c.req.path} - Error: ${
        (err as Error).message
      } (${(err as Error).constructor.name})`,
    );
    if (Deno.env.get("NODE_ENV") === "production") {
      Sentry.setContext("request", {
        method: c.req.method,
        path: c.req.path,
        requestId: c.get("requestId"),
      });
      Sentry.setTag("route", c.req.path);
      Sentry.setTag("error_id", errorId);
      const userId = c.get("userId") as string | undefined;
      if (userId) {
        Sentry.setUser({ id: userId });
      }
      // Stable fingerprint (exception + first code frame) so repeated
      // occurrences of the same bug group into one Sentry issue instead of
      // flooding the remediation pipeline with near-duplicates.
      const fingerprint = buildErrorFingerprint(err);
      if (fingerprint) {
        Sentry.setContext("fingerprint", { value: fingerprint });
      }
      Sentry.captureException(
        err,
        fingerprint ? { fingerprint: [fingerprint] } : undefined,
      );
      // Flush before responding — the isolate may be reaped immediately after
      // the response, and a buffered envelope would be lost.
      await Sentry.flush(2000);
    }
    // Standard envelope (was a bare `{ error: string }` — clients parsing
    // `{ error: { code, message }, requestId }` broke on 500s).
    return errorEnvelope(c, "INTERNAL_ERROR", "Internal Server Error", 500, {
      errorId,
    });
  }
};

app.use(async (c, next) => {
  try {
    await next();
  } catch (err) {
    return handleApiError(err, c);
  }
});

app.onError((err, c) => {
  return handleApiError(err, c);
});

// 5. Service Role Middleware (injects supabaseUrl + serviceRoleKey into context — must run before auth)
app.use(serviceRoleMiddleware);

// 6. Auth Middleware (centralized authentication, skips public auth routes)
app.use("*", authMiddleware);

// === NATIVE HONO ROUTERS ===
// Dual-mount invariant lives in ./_shared/router.ts (single source of truth).
// Local/direct requests arrive as /api/*; Supabase Edge Runtime strips the
// /functions/v1/api prefix so handlers see /*. Both shapes must work.
mountRouter(app, "/api", settingsRouter);
mountRouter(app, "/api/debug", debugRouter);
mountRouter(app, "/api", metadataRouter);
mountRouter(app, "/api/authors", authorsRouter);
mountRouter(app, "/api/users", usersRouter);
mountRouter(app, "/api/libraries", librariesRouter);
mountRouter(app, "/api/items", itemsRouter);
mountRouter(app, "/api", playbackRouter);
mountRouter(app, "/api", progressRouter);
mountRouter(app, "/api/playlists", playlistsRouter);
mountRouter(app, "/api/collections", collectionsRouter);
mountRouter(app, "/api/auth", authRouter);
mountRouter(app, "/api", authRouter);
mountRouter(app, "/api/auth/2fa", twoFactorRouter);
mountRouter(app, "/api/2fa", twoFactorRouter);
mountRouter(app, "/api/auth/2fa/webauthn", webauthnRouter);
mountRouter(app, "/api/2fa/webauthn", webauthnRouter);
mountRouter(app, "/api/migrate-batch", migrateBatchRouter);
mountRouter(app, "/api/items", downloadsRouter);
mountRouter(app, "/api", downloadsRouter);
mountRouter(app, "/api/me/bookmarks", bookmarksRouter);
mountRouter(app, "/api/me/search", searchRouter);
mountRouter(app, "/api/search", searchRouter);
mountRouter(app, "/api", searchRouter);
// Sentry monitoring and health check endpoints (no auth required)
mountRouter(app, "/api/sentry", sentryRouter);
mountRouter(app, "/api/me", meRouter);
mountRouter(app, "/api/admin", adminRouter);
mountRouter(app, "/api/admin/analytics", adminRouter);
mountRouter(app, "/api/admin-analytics", adminRouter);
mountRouter(app, "/api/ai", aiRouter);

const chapterAiRouter = new Hono<{ Variables: Variables }>();
chapterAiRouter.post("/chapter-ai", handleChapterAI);
chapterAiRouter.post("/ai/chapter", handleChapterAI);
mountRouter(app, "/api", chapterAiRouter);

// Live OpenAPI document — single source of truth for typed clients,
// Schemathesis fuzzing, and on-call debugging (no deploy needed).
app.get("/api/openapi.json", (c) => {
  const doc = app.getOpenAPIDocument({
    openapi: "3.1.0",
    info: {
      title: "Audiobookphile API",
      description: "Schema-first Audiobookshelf-compatible edge API.",
      version: "2026.07.24",
    },
  });
  return c.json(doc);
});
app.get("/openapi.json", (c) => {
  const doc = app.getOpenAPIDocument({
    openapi: "3.1.0",
    info: {
      title: "Audiobookphile API",
      description: "Schema-first Audiobookshelf-compatible edge API.",
      version: "2026.07.24",
    },
  });
  return c.json(doc);
});

// Fallback 404 — standard envelope so clients never branch on shape.
app.all("*", (c) => {
  return errorEnvelope(
    c,
    "NOT_FOUND",
    "Endpoint not found or method not supported",
    404,
  );
});

export { app };
export default app;

Deno.serve(app.fetch);
