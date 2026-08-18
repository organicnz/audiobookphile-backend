/**
 * OpenAPI document generator (schema-first API)
 *
 * Builds the full Hono app (including all routers, migrated or not) and
 * serialises the OpenAPI document registered via createRoute() to JSON.
 * The document is a CI artifact: Schemathesis fuzz-tests every declared
 * endpoint against it in the post-deploy verification job, and it serves as
 * the living API reference.
 *
 * Usage:
 *   deno run --allow-env --allow-net --allow-write --allow-read generate_openapi.ts [output-path]
 *
 * The default output path is ./openapi.json (next to this file).
 */
import app from "./index.ts";

const outputPath = Deno.args[0] || "./openapi.json";

const document = app.getOpenAPIDocument({
  openapi: "3.1.0",
  info: {
    title: "Audiobookphile API",
    description:
      "Schema-first Audiobookshelf-compatible edge API. Endpoints declared " +
      "via @hono/zod-openapi are validated and fuzz-tested in CI " +
      "(Schemathesis) against this document.",
    version: "2026.07.24",
  },
});

Deno.writeTextFileSync(outputPath, JSON.stringify(document, null, 2));
Deno.stdout.writeSync(
  new TextEncoder().encode(
    `Wrote ${outputPath} (${Object.keys(document.paths).length} paths)\n`,
  ),
);
Deno.exit(0);
