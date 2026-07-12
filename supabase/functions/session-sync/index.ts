import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { upsertMediaProgress } from "../_shared/progress.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/");
    const sessionId = pathParts[pathParts.length - 1];

    if (!sessionId || sessionId === "session-sync") {
      return new Response(
        JSON.stringify({ error: "Invalid session ID in path" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const [libraryItemId, sessionUuid] = sessionId.split("__");
    if (!libraryItemId) {
      return new Response(
        JSON.stringify({ error: "Invalid session ID format" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const body = await req.json();
    const { currentTime, duration, progress, timeListened } = body;

    if (typeof currentTime !== "number") {
      return new Response(
        JSON.stringify({ error: "currentTime must be a number" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    await upsertMediaProgress(supabase, user.id, libraryItemId, null, {
      progress: progress,
      duration: duration,
      currentTime: currentTime,
    });

    if (sessionUuid) {
      await supabase.from("playback_sessions")
        .update({
          current_time_pos: currentTime,
          time_listening: timeListened || 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionUuid);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
