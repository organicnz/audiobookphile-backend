import { Hono } from "hono";
import { Sentry } from "../../_shared/sentry.ts";

const sentryRouter = new Hono();

/**
 * Sentry health check endpoint
 * GET /sentry/health
 *
 * Returns Sentry client status and optionally sends a test event
 */
sentryRouter.get("/health", async (c) => {
  const client = Sentry.getClient();
  const initialized = Boolean(client);

  // Check if test event should be sent
  const sendTest = c.req.query("test") === "true";
  let testEventId: string | undefined;

  if (sendTest && initialized) {
    try {
      testEventId = Sentry.captureMessage("Sentry health check ping", "debug");
    } catch (err) {
      return c.json({
        healthy: false,
        initialized,
        error: `Test event failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }, 500);
    }
  }

  return c.json({
    healthy: initialized,
    initialized,
    client: initialized ? "active" : "not_configured",
    testEventId,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Sentry Cron monitoring heartbeat
 * POST /sentry/cron/:monitorSlug
 *
 * Sends a check-in to Sentry for cron job monitoring
 * Used by scheduled tasks to report their status
 */
sentryRouter.post("/cron/:monitorSlug", async (c) => {
  const monitorSlug = c.req.param("monitorSlug");
  const body = await c.req.json().catch(() => ({}));
  const status = body.status || "in_progress";

  const client = Sentry.getClient();
  if (!client) {
    return c.json({
      error: "Sentry not configured",
      monitorSlug,
    }, 503);
  }

  try {
    // Sentry cron monitoring via check-ins
    const checkInPayload = status === "ok"
      ? (body.checkInId
        ? {
          monitorSlug,
          status: "ok" as const,
          checkInId: body.checkInId,
          duration: body.duration,
        }
        : { monitorSlug, status: "ok" as const })
      : status === "error"
      ? (body.checkInId
        ? {
          monitorSlug,
          status: "error" as const,
          checkInId: body.checkInId,
          duration: body.duration,
        }
        : { monitorSlug, status: "error" as const })
      : { monitorSlug, status: "in_progress" as const };

    const checkInId = Sentry.captureCheckIn(checkInPayload, {
      schedule: {
        type: "crontab",
        value: body.schedule || "0 * * * *", // Default: hourly
      },
      timezone: body.timezone || "UTC",
    });

    return c.json({
      success: true,
      monitorSlug,
      checkInId,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({
      error: "Failed to send check-in",
      message: err instanceof Error ? err.message : String(err),
      monitorSlug,
    }, 500);
  }
});

/**
 * Sentry metrics endpoint
 * GET /sentry/metrics
 *
 * Returns current Sentry initialization status and environment info.
 * Does not expose internal scope state (tags/extras are not public API).
 */
sentryRouter.get("/metrics", (c) => {
  const client = Sentry.getClient();

  if (!client) {
    return c.json({
      error: "Sentry not configured",
    }, 503);
  }

  return c.json({
    initialized: true,
    environment: Deno.env.get("NODE_ENV") || "development",
    release: Deno.env.get("DENO_DEPLOYMENT_ID") || "unknown",
    timestamp: new Date().toISOString(),
  });
});

export { sentryRouter };
