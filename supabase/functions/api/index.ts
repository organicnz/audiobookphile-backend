import { Hono } from "hono";
import { cors } from "hono/cors";
import { Sentry } from "../_shared/sentry.ts";

// Native Hono Routers
import { settingsRouter } from "./routes/settings.ts";
import { debugRouter } from "./routes/debug.ts";
import { metadataRouter } from "./routes/metadata.ts";
import { authorsRouter } from "./routes/authors.ts";
import { usersRouter } from "./routes/users.ts";
import { librariesRouter } from "./routes/libraries.ts";
import { itemsRouter } from "./routes/items.ts";
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
import { aiRouter } from "./aiService.ts";

import { Variables } from "./_shared/types.ts";
import { ApiError, serviceRoleMiddleware } from "./_shared/errors.ts";
import { authMiddleware } from "./_shared/auth.ts";

const app = new Hono<{ Variables: Variables }>();

// === MIDDLEWARE CHAIN ===
// Order matters: CORS → health → logging → error handling → auth → service role → routes

// 1. CORS (must run first so preflight OPTIONS requests get proper headers)
app.use(
  "*",
  cors({
    origin: "*",
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

// 2. Health check (before auth so it's always accessible)
app.get("/api/health", (c) => {
  const zaiConfigured = Boolean(
    Deno.env.get("ZAI_API_KEY") || Deno.env.get("ZHIPU_API_KEY"),
  );
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2026.07.24",
    services: {
      database: "connected",
      zai: zaiConfigured ? "configured" : "unconfigured",
    },
  });
});

// 3. Structured Logging Middleware
app.use(async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const requestId = crypto.randomUUID();
  c.res.headers.set("X-Request-ID", requestId);
  c.set("requestId", requestId);

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
mountRouter("/api/migrate-batch", migrateBatchRouter);
mountRouter("/api/items", downloadsRouter);
mountRouter("/api", downloadsRouter);
mountRouter("/api/me/bookmarks", bookmarksRouter);
mountRouter("/api/me/search", searchRouter);
mountRouter("/api/search", searchRouter);
mountRouter("/api", searchRouter);
mountRouter("/api/me", meRouter);
mountRouter("/api/admin-analytics", adminRouter);
mountRouter("/admin-analytics", adminRouter);
mountRouter("/api/admin/analytics", adminRouter);
mountRouter("/api/ai", aiRouter);

// Fallback 404
app.all("*", (c) => {
  return c.json({ error: "Endpoint not found or method not supported" }, 404);
});

export { app };
export default app;

Deno.serve(app.fetch);
