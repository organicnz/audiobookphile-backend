import { z } from "zod";
import { Hono } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";

export const migrateBatchRouter = new Hono<{ Variables: Variables }>();

// ===== Zod schemas for migration batch endpoint =====
const MigrationBatchSchema = z.object({
  table: z.string().min(1, "Table name is required"),
  rows: z.array(z.unknown()).length(1, "At least one row is required"),
});

migrateBatchRouter.post("/", async (c) => {
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

  return c.json({ success: true, count: rows.length });
});
