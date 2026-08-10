import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";
import { requireAdminRole } from "../_shared/auth.ts";

export const adminRouter = new Hono<{ Variables: Variables }>();

adminRouter.all("*", async (c) => {
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

    // Count library items
    const { count: totalBooks } = await adminSupabase
      .from("books")
      .select("*", { count: "exact", head: true });
    const { count: totalPodcasts } = await adminSupabase
      .from("podcasts")
      .select("*", { count: "exact", head: true });

    const totalItems = (totalBooks || 0) + (totalPodcasts || 0);

    return c.json({
      totalUsers: totalUsers || 0,
      totalLibraries: totalLibraries || 0,
      totalItems: totalItems || 0,
      activeSessions: 1,
    });
  } catch (err) {
    console.error("[admin-analytics] Error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});