import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";
export const debugRouter = new Hono<{ Variables: Variables }>();

debugRouter.get("/:id", async (c) => {
  const _user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl") as string;
  const serviceRoleKey = c.get("serviceRoleKey") as string;
  const _adminClient = _createClient(supabaseUrl, serviceRoleKey);

  const _requiresServiceRole = true;

  const itemId = c.req.param("id");
  const { data: item } = await _adminClient.from("library_items").select(
    "*, books(*)",
  ).eq("id", itemId).single();
  return c.json(item);
});
