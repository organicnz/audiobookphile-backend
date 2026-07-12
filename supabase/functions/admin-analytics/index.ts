import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Auth client with service role key to bypass RLS for DB aggregation,
    // but we will authenticate the user first to ensure they are an admin.
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Verify user is an admin by checking their profile
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("user_type")
      .eq("id", user.id)
      .single();

    if (profileError || profile?.user_type !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden: Admins only" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    // 1. Get total users count
    const { count: totalUsers, error: usersErr } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true });

    if (usersErr) throw new Error(usersErr.message);

    // 2. Get total libraries count
    const { count: totalLibraries, error: libsErr } = await supabase
      .from("libraries")
      .select("*", { count: "exact", head: true });

    if (libsErr) throw new Error(libsErr.message);

    // 3. Get total library items count
    const { count: totalItems, error: itemsErr } = await supabase
      .from("library_items")
      .select("*", { count: "exact", head: true });

    if (itemsErr) throw new Error(itemsErr.message);

    // 4. Get active playback sessions
    let activeSessions = 0;
    try {
      const { count, error: sessionsErr } = await supabase
        .from("playback_sessions")
        .select("*", { count: "exact", head: true });
      // Could filter by updated_at recent...
      if (!sessionsErr && count) activeSessions = count;
    } catch {
      // Ignore if table doesn't exist
    }

    return new Response(
      JSON.stringify({
        totalUsers: totalUsers || 0,
        totalLibraries: totalLibraries || 0,
        totalItems: totalItems || 0,
        activeSessions,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: unknown) {
    const err = e as Error;
    console.error("Analytics error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
