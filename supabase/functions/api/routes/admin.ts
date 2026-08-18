import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { requireAdminRole } from "../_shared/auth.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const adminRouter = createOpenApiRouter();

const ForbiddenSchema = z.object({ error: z.string() });
const ServerErrorSchema = z.object({ error: z.string() });
const AnalyticsSchema = z.object({
  totalUsers: z.number(),
  totalLibraries: z.number(),
  totalItems: z.number(),
  activeSessions: z.number(),
});

const analyticsRoute = {
  method: "get" as const,
  path: "/",
  tags: ["admin"],
  responses: {
    200: {
      description: "Server analytics overview",
      content: { "application/json": { schema: AnalyticsSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

adminRouter.openapi(analyticsRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  try {
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    // Count users
    const { count: totalUsers } = await adminSupabase
      .from("profiles")
      .select("*", { count: "exact", head: true });

    // Count libraries
    const { count: totalLibraries } = await adminSupabase
      .from("libraries")
      .select("*", { count: "exact", head: true });

    // Count library items by media type (books/podcasts tables do not exist)
    const { count: totalBooks } = await adminSupabase
      .from("library_items")
      .select("*", { count: "exact", head: true })
      .eq("media_type", "book");
    const { count: totalPodcasts } = await adminSupabase
      .from("library_items")
      .select("*", { count: "exact", head: true })
      .eq("media_type", "podcast");

    const totalItems = (totalBooks || 0) + (totalPodcasts || 0);

    return c.json({
      totalUsers: totalUsers || 0,
      totalLibraries: totalLibraries || 0,
      totalItems: totalItems || 0,
      activeSessions: 1,
    }, 200);
  } catch (err) {
    console.error("[admin-analytics] Error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
