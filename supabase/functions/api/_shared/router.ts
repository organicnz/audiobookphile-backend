/**
 * Canonical dual-mount router helper.
 *
 * Supabase Edge Runtime strips the `/functions/v1/api` prefix before the
 * request reaches Hono, so handlers see `/libraries` — while local dev and
 * direct calls arrive as `/api/libraries`. Every router MUST be mounted under
 * BOTH shapes or one call path 404s.
 *
 * `mountRouter` is the single place that encodes this invariant. Use it for
 * every new router — never `app.route()` directly.
 */

// Intentionally loose Hono types: routers mix `Hono` and `OpenAPIHono` with
// different Variables generics. The runtime mount is identical; strict
// generics here only produced false-positive type errors with zero safety win.
// deno-lint-ignore-file no-explicit-any

/**
 * Mount `router` at `path` AND at its `/api`-stripped alias.
 *
 * @example
 *   mountRouter(app, "/api/libraries", librariesRouter);
 *   // → serves /api/libraries/* AND /libraries/*
 */
export function mountRouter(app: any, path: string, router: any): void {
  app.route(path, router);
  if (path.startsWith("/api/")) {
    app.route(path.substring(4), router);
  } else if (path === "/api") {
    app.route("/", router);
  }
}
