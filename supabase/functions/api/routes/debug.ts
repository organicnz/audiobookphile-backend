import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";

import { Variables } from "../_shared/types.ts";
export const debugRouter = new Hono<{ Variables: Variables }>();

debugRouter.get("/:id", async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl") as string;
  const serviceRoleKey = c.get("serviceRoleKey") as string;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Auth Check
  const { data: profile } = await adminClient.from("profiles").select(
    "user_type",
  ).eq("id", user.id).single();
  if (
    !profile || (profile.user_type !== "admin" && profile.user_type !== "root")
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const itemId = c.req.param("id");
  const { data: item } = await adminClient.from("library_items").select(
    "*, books(*)",
  ).eq("id", itemId).single();
  return c.json(item);
});
