import { Hono } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";

export const migrateBatchRouter = new Hono<{ Variables: Variables }>();

migrateBatchRouter.post("/", async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { table, rows } = await c.req.json();

  if (!table || !rows || !Array.isArray(rows)) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  console.log(`Upserting ${rows.length} rows to ${table}...`);
  const { data, error } = await adminClient
    .from(table)
    .upsert(rows, {
      onConflict: "id",
    })
    .select("id");
  console.log(`Upsert result: data length ${data?.length}, error`, error);
  if (error) {
    console.error(`Migration error for ${table}:`, error);
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true, count: rows.length });
});
