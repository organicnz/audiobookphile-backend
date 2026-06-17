import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
import { Variables } from "../_shared/types.ts";

export const migrateBatchRouter = new Hono<{ Variables: Variables }>();

migrateBatchRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { table, rows } = await c.req.json();

  if (!table || !rows || !Array.isArray(rows)) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  console.log(`Upserting ${rows.length} rows to ${table}...`);
  const { data, error } = await adminClient.from(table).upsert(rows, {
    onConflict: "id",
  }).select("id");
  console.log(`Upsert result: data length ${data?.length}, error`, error);
  if (error) {
    console.error(`Migration error for ${table}:`, error);
    return c.json({ error: error.message }, 500);
  }

  return c.json({ success: true, count: rows.length });
});
