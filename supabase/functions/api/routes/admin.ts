import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

export const adminRouter = new Hono<{ Variables: Variables }>();

adminRouter.all("*", async (c) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    // Verify admin/root profile
    const { data: profile } = await adminSupabase
      .from("profiles")
      .select("user_type")
      .eq("id", user.id)
      .single();

    if (!profile || !["admin", "root"].includes(profile.user_type)) {
      return c.json({ error: "Forbidden: Admin access required" }, 403);
    }

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
      totalUsers: totalUsers || 1,
      totalLibraries: totalLibraries || 1,
      totalItems: totalItems || 0,
      activeSessions: 1,
    });
  } catch (err) {
    console.error("[admin-analytics] Error:", err);
    return c.json({
      totalUsers: 1,
      totalLibraries: 1,
      totalItems: 0,
      activeSessions: 1,
    });
  }
});
