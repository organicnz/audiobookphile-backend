import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Sentry } from "../_shared/sentry.ts";

// Native Hono Routers
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

import { Variables } from "./_shared/types.ts";
import { ApiError, serviceRoleMiddleware } from "./_shared/errors.ts";
import { authMiddleware } from "./_shared/auth.ts";
import { runContractChecks } from "./_shared/contracts.ts";

const app = new Hono<{ Variables: Variables }>();

// === MIDDLEWARE CHAIN ===
// Order matters: CORS → health → logging → error handling → auth → service role → routes

// 1. CORS (must run first so preflight OPTIONS requests get proper headers)
// Restricted to the web app, Vercel preview deployments and local dev.
// Requests without an Origin header (native apps, cron, curl) are always
// allowed — CORS is a browser enforcement mechanism only.
const ALLOWED_ORIGINS = [
  "https://audiobookphile.vercel.app",
  "https://audiobookphile.vercel.app/",
];
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/audiobookphile-[a-z0-9-]+\.vercel\.app$/i, // preview deployments
  /^http:\/\/localhost:\d+$/i,
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
    ],
  }),
);

// 2. Alias deprecation log (P2.1): the canonical paths are the runtime-stripped
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
app.get("/api/health", async (c) => {
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
  const tableStatus: Record<string, string> = {};
  if (url && serviceRoleKey) {
    const client = createClient(url, serviceRoleKey);
    await Promise.all(
      tables.map(async (table) => {
        const { error } = await client.from(table).select("id", {
          count: "exact",
          head: true,
        });
        tableStatus[table] = error ? "error" : "ok";
      }),
    );
  } else {
    for (const table of tables) tableStatus[table] = "unconfigured";
  }

  const payload: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2026.07.24",
    services: {
      database: url && serviceRoleKey ? "connected" : "unconfigured",
      zai: zaiConfigured ? "configured" : "unconfigured",
    },
    tables: tableStatus,
  };

  // Contract shape checks (P1.3). The nested /api/health check sends
  // x-contract-check so it does not recurse into itself.
  if (c.req.header("x-contract-check") !== "1") {
    payload.contracts = await runContractChecks(app);
  }

  return c.json(payload);
});

// 4. Structured Logging Middleware
app.use(async (c, next) => {
  const start = Date.now();
  // Set the request id BEFORE next() so error envelopes thrown by handlers
  // (serialised by handleApiError) always carry requestId.
  const requestId = crypto.randomUUID();
  c.res.headers.set("X-Request-ID", requestId);
  c.set("requestId", requestId);
  await next();
  const duration = Date.now() - start;

  // Only log in production
  if (Deno.env.get("NODE_ENV") === "production") {
    const log = {
      level: "info",
      timestamp: new Date().toISOString(),
      requestId,
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
      headers: { "x-client-info": c.req.header("x-client-info") },
      statusCode: c.res.status,
      durationMs: duration,
      user: c.get("user")?.email,
      ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") ||
        "unknown",
    };
    console.log(JSON.stringify(log));
  }
});

// 4. Error Handling (Middleware & onError)
const handleApiError = (err: unknown, c: any) => {
  const apiErr = err as ApiError;
  if (apiErr?.statusCode) {
    return c.json(
      {
        error: {
          code: apiErr.code,
          message: apiErr.message,
          ...(apiErr.field ? { field: apiErr.field } : {}),
          ...(apiErr.validationErrors
            ? { validationErrors: apiErr.validationErrors }
            : {}),
        },
        requestId: c.get("requestId"),
        timestamp: new Date().toISOString(),
      },
      apiErr.statusCode,
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
      const userId = c.get("userId") as string | undefined;
      if (userId) {
        Sentry.setUser({ id: userId });
      }
      Sentry.captureException(err);
    }
    return c.json({ error: "Internal Server Error" }, 500);
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
// mountRouter registers each router under BOTH its full path (/api/...) AND
// its path with the /api prefix stripped (/...). This is required because:
//   - Local/direct requests arrive as /api/libraries, /api/items, etc.
//   - Supabase Edge Runtime strips the function name prefix (/functions/v1/api)
//     before the request reaches this handler, so the router sees /libraries,
//     /items, etc. — without the /api segment.
// DO NOT remove the double-mount. The app will break for one of those two
// call paths if you do. If you add a new router, use mountRouter — not app.route directly.
const mountRouter = (path: string, router: any) => {
  app.route(path, router);
  if (path.startsWith("/api/")) {
    app.route(path.substring(4), router);
  } else if (path === "/api") {
    app.route("/", router);
  }
};

mountRouter("/api", settingsRouter);
mountRouter("/api/debug", debugRouter);
mountRouter("/api", metadataRouter);
mountRouter("/api/authors", authorsRouter);
mountRouter("/api/users", usersRouter);
mountRouter("/api/libraries", librariesRouter);
mountRouter("/api/items", itemsRouter);
mountRouter("/api", playbackRouter);
mountRouter("/api", progressRouter);
mountRouter("/api/playlists", playlistsRouter);
mountRouter("/api/collections", collectionsRouter);
mountRouter("/api/auth", authRouter);
mountRouter("/api", authRouter);
mountRouter("/api/auth/2fa", twoFactorRouter);
mountRouter("/api/2fa", twoFactorRouter);
mountRouter("/api/auth/2fa/webauthn", webauthnRouter);
mountRouter("/api/2fa/webauthn", webauthnRouter);
mountRouter("/api/migrate-batch", migrateBatchRouter);
mountRouter("/api/items", downloadsRouter);
mountRouter("/api", downloadsRouter);
mountRouter("/api/me/bookmarks", bookmarksRouter);
mountRouter("/api/me/search", searchRouter);
mountRouter("/api/search", searchRouter);
mountRouter("/api", searchRouter);
mountRouter("/api/me", meRouter);
mountRouter("/api/admin/analytics", adminRouter);
mountRouter("/api/admin-analytics", adminRouter);
mountRouter("/api/ai", aiRouter);

const chapterAiRouter = new Hono<{ Variables: Variables }>();
chapterAiRouter.post("/chapter-ai", handleChapterAI);
chapterAiRouter.post("/ai/chapter", handleChapterAI);
mountRouter("/api", chapterAiRouter);

// Fallback 404
app.all("*", (c) => {
  return c.json({ error: "Endpoint not found or method not supported" }, 404);
});

export { app };
export default app;

Deno.serve(app.fetch);
