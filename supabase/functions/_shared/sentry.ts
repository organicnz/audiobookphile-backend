import * as Sentry from "@sentry/deno";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("NODE_ENV") || "development",
  tracesSampleRate: 1.0,
});

export { Sentry };
