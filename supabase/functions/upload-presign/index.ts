import { createClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { corsHeaders } from "../_shared/cors.ts";
import { Database } from "../../../src/types/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });
    const db = createClient<Database>(supabaseUrl, serviceRoleKey);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await db.from("profiles").select("user_type").eq(
      "id",
      user.id,
    ).single();
    if (!profile || !["admin", "root"].includes(profile.user_type ?? "")) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { filename, contentType } = await req.json();

    if (!filename) {
      return new Response(JSON.stringify({ error: "Filename is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // User requested to fully use Backblaze for all audiobook files
    if (Deno.env.get("B2_ENDPOINT") && Deno.env.get("B2_BUCKET_NAME")) {
      const s3Client = new S3Client({
        endpoint: Deno.env.get("B2_ENDPOINT")!,
        region: Deno.env.get("B2_REGION") || "us-west-004",
        credentials: {
          accessKeyId: Deno.env.get("B2_KEY_ID")!,
          secretAccessKey: Deno.env.get("B2_APP_KEY")!,
        },
        forcePathStyle: true,
        // @ts-ignore: These might not be present in all aws-sdk versions but help with B2
        requestChecksumCalculation: "WHEN_REQUIRED",
        // @ts-ignore
        responseChecksumValidation: "WHEN_REQUIRED",
      });

      const command = new PutObjectCommand({
        Bucket: Deno.env.get("B2_BUCKET_NAME")!,
        Key: filename,
        ContentType: contentType || "application/octet-stream",
      });

      const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      return new Response(JSON.stringify({ url, provider_prefix: "b2://" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      const { data, error } = await supabase.storage
        .from("audio-files")
        .createSignedUploadUrl(filename, { upsert: true });

      if (error || !data?.signedUrl) {
        throw new Error(`Supabase presign error: ${error?.message}`);
      }

      const signedUrl = data.signedUrl;

      return new Response(
        JSON.stringify({ url: signedUrl, provider_prefix: "supabase://" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  } catch (e: unknown) {
    const err = e as Error;
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
