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

// 4. Error Handling Middleware
app.use(async (c, next) => {
  try {
    await next();
  } catch (err) {
    // Distinguish between ApiError (API errors) and generic errors (server errors)
    const apiErr = err as ApiError;
    if (apiErr?.statusCode) {
      // API error - return proper JSON response
      c.res = c.json(
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
      // Already a Response (from error handler)
      return err;
    } else {
      // Generic error - log and return 500
      const errorId = crypto.randomUUID();
      console.error(
        `[API Index] Unhandled error [${errorId}] - Request: ${c.req.method} ${c.req.path} - Error: ${
          (err as Error).message
        } (${(err as Error).constructor.name})`,
      );
      // Optionally report to Sentry in production
      if (Deno.env.get("NODE_ENV") === "production") {
        Sentry.captureException(err);
      }
      return c.json({ error: "Internal Server Error" }, 500);
    }
  }
});

// 5. Auth Middleware (centralized authentication, skips auth routes)
app.use("*", authMiddleware);

// 6. Service Role Middleware
app.use(serviceRoleMiddleware);

// === NATIVE HONO ROUTERS ===
// Routes are mounted here, middleware chain applies to all
app.route("/api", settingsRouter);
app.route("/api/debug", debugRouter);
app.route("/api", metadataRouter);
app.route("/api/authors", authorsRouter);
app.route("/api/users", usersRouter);
app.route("/api/libraries", librariesRouter);
app.route("/api/items", itemsRouter);
app.route("/api", playbackRouter);
app.route("/api", progressRouter);
app.route("/api/playlists", playlistsRouter);
app.route("/api/collections", collectionsRouter);
app.route("/api/auth", authRouter);
app.route("/api/migrate-batch", migrateBatchRouter);
app.route("/api/items", downloadsRouter);
app.route("/api/me/bookmarks", bookmarksRouter);
app.route("/api/me/search", searchRouter);
app.route("/api/me", meRouter);

// Fallback 404
app.all("*", (c) => {
  return c.json({ error: "Endpoint not found or method not supported" }, 404);
});

Deno.serve(app.fetch);
