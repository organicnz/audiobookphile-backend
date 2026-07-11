import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "@supabase/supabase-js";
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

import { Variables } from "./_shared/types.ts";

const app = new Hono<{ Variables: Variables }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["authorization", "x-client-info", "apikey", "content-type"],
  }),
);

app.use("*", async (c, next) => {
  const req = c.req.raw;
  const urlObj = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const authHeader = req.headers.get("Authorization");

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
  });

  c.set("supabaseUrl", supabaseUrl);
  c.set("serviceRoleKey", serviceRoleKey);
  c.set("supabase", supabase);

  const requireUser = async () => {
    const jwt = authHeader?.replace("Bearer ", "") || "";
    const { data: { user }, error: _error } = await supabase.auth.getUser(jwt);
    if (!user) throw new Error("Unauthorized");
    return user;
  };

  c.set("requireUser", requireUser);

  // Set user for downstream routes, skipping auth for certain public/login paths
  try {
    let user = null;
    const isGetCover = urlObj.pathname.includes("/api/items") &&
      urlObj.pathname.endsWith("/cover") && req.method === "GET";
    const isLogin = urlObj.pathname.includes("/api/login");
    const isSignup = urlObj.pathname.includes("/api/signup");
    const isForgotPassword = urlObj.pathname.includes(
      "/api/auth/forgot-password",
    );
    const isResetPassword = urlObj.pathname.includes(
      "/api/auth/reset-password",
    );
    const isRefresh = urlObj.pathname.includes("/api/auth/refresh");

    if (
      !isGetCover && !isLogin && !isSignup && !isForgotPassword &&
      !isResetPassword && !isRefresh
    ) {
      user = await requireUser();
    }

    c.set("user", user);

    await next();
  } catch (e) {
    if ((e as Error).message === "Unauthorized") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Capture unhandled exceptions in Sentry
    Sentry.captureException(e);

    console.error(`[API Index] Fatal Error:`, (e as Error).message);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// === NATIVE HONO ROUTERS ===
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
app.route("/api", authRouter);
app.route("/api/migrate-batch", migrateBatchRouter);

// Fallback 404
app.all("*", (c) => {
  return c.json({ error: "Endpoint not found or method not supported" }, 404);
});

serve(app.fetch);
