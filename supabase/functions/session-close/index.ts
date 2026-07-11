import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
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

    if (!sessionId || sessionId === "session-close") {
      return new Response(
        JSON.stringify({ error: "Invalid session ID in path" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const [libraryItemId] = sessionId.split("__");
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
    const { currentTime, duration } = body;

    if (typeof currentTime !== "number") {
      return new Response(
        JSON.stringify({ error: "currentTime must be a number" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const finalDuration = duration || 0;
    const progress = finalDuration > 0 ? currentTime / finalDuration : 0;
    const isFinished = finalDuration > 0 && currentTime >= finalDuration - 5;

    const { error: upsertError } = await supabase
      .from("media_progress")
      .upsert(
        {
          user_id: user.id,
          library_item_id: libraryItemId,
          episode_id: null,
          current_time_pos: currentTime,
          duration: finalDuration,
          progress: progress,
          is_finished: isFinished,
          last_update: new Date().toISOString(),
        },
        { onConflict: "user_id,library_item_id,episode_id" },
      );

    if (upsertError) throw upsertError;

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
