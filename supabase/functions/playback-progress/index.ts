import { createClient } from "npm:@supabase/supabase-js@2.44.0";
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

    const body = await req.json();
    const { itemId, episodeId, currentTime, duration, isFinished } = body;

    if (!itemId || typeof itemId !== "string") {
      return new Response(JSON.stringify({ error: "itemId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof currentTime !== "number") {
      return new Response(
        JSON.stringify({ error: "currentTime must be a number" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const progress = duration ? currentTime / duration : undefined;

    await upsertMediaProgress(supabase, user.id, itemId, episodeId ?? null, {
      currentTime,
      duration,
      progress,
      isFinished: isFinished ?? false,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
