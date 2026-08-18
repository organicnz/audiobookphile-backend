import { createClient } from "npm:@supabase/supabase-js@2.44.0";

import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const debugRouter = createOpenApiRouter();

const ServerErrorSchema = z.object({ error: z.string() });

const debugItemRoute = {
  method: "get" as const,
  path: "/:id",
  tags: ["debug"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Raw library item row",
      content: { "application/json": { schema: z.record(z.any()) } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

debugRouter.openapi(debugItemRoute, async (c) => {
  const _user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl") as string;
  const serviceRoleKey = c.get("serviceRoleKey") as string;
  const _adminClient = createClient(supabaseUrl, serviceRoleKey);

  const _requiresServiceRole = true;

  const { id: itemId } = c.req.valid("param");
  const { data: item } = await _adminClient.from("library_items").select(
    "*",
  ).eq("id", itemId).single();
  return c.json(item as any, 200);
});
