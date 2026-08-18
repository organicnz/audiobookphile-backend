import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { requireAdminRole } from "../_shared/auth.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const migrateBatchRouter = createOpenApiRouter();

// ===== Zod schemas for migration batch endpoint =====
const MigrationBatchSchema = z.object({
  table: z.string().min(1, "Table name is required"),
  rows: z.array(z.unknown()).length(1, "At least one row is required"),
});

const ForbiddenSchema = z.object({ error: z.string() });
const ServerErrorSchema = z.object({ error: z.string() });
const SuccessSchema = z.object({
  success: z.boolean(),
  count: z.number(),
});

const migrateBatchRoute = {
  method: "post" as const,
  path: "/",
  tags: ["admin"],
  responses: {
    200: {
      description: "Batch upsert completed",
      content: { "application/json": { schema: SuccessSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.any()),
        },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

migrateBatchRouter.openapi(migrateBatchRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate with Zod schema (rows must be an array, table is a string)
  const parsed = MigrationBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { table, rows } = parsed.data;
  if (!Array.isArray(rows)) {
    return c.json({ error: "rows must be an array" }, 400);
  }

  const { error } = await adminClient
    .from(table)
    .upsert(rows, {
      onConflict: "id",
    })
    .select("id");
  if (error) {
    console.error(`Migration error for ${table}:`, error);
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true, count: rows.length }, 200);
});
