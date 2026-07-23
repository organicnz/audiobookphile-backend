import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { corsHeaders } from "../_shared/cors.ts";
import { z } from "npm:zod@3.23.8";

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
    const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
      Deno.env.get("ZHIPU_API_KEY") ?? "";

    if (!zaiApiKey) {
      return new Response(
        JSON.stringify({
          error:
            "ZAI_API_KEY (or ZHIPU_API_KEY) is not configured on the server",
        }),
        { status: 500, headers: corsHeaders },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
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

    const RequestSchema = z.object({
      title: z.string(),
      author: z.string().optional(),
      chapterTitle: z.string(),
      chapterIndex: z.number().optional(),
    });

    const body = await req.json();
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid request payload",
          details: parsed.error.issues,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const { title, author, chapterTitle, chapterIndex } = parsed.data;

    // Call Z.AI GLM-4 API
    const prompt = `You are an expert literary scholar and audiobook companion. 
Provide a concise, high-level executive summary and key takeaways for Chapter ${
      chapterIndex ?? ""
    }: "${chapterTitle}" from the audiobook "${title}" by ${
      author || "Unknown Author"
    }.

Format response in valid JSON with key "summary" (2-3 sentences), "keyTakeaways" (array of 3 bullet strings), and "mood" (string).`;

    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [
            {
              role: "system",
              content: "You respond strictly in valid JSON format.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.5,
        }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to call Z.AI API: ${errText}`);
    }

    const zaiData = await res.json();
    const rawContent = zaiData.choices?.[0]?.message?.content ?? "{}";

    let jsonResult = {};
    try {
      jsonResult = JSON.parse(
        rawContent.replace(/```json\n?|\n?```/g, "").trim(),
      );
    } catch {
      jsonResult = { summary: rawContent, keyTakeaways: [], mood: "Engaging" };
    }

    return new Response(JSON.stringify({ insights: jsonResult }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const err = e as Error;
    console.error("Z.AI Chapter AI error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
