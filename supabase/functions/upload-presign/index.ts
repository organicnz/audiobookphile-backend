import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { corsHeaders } from "../_shared/cors.ts";
import { Database } from "../../../src/types/supabase.ts";

// Cached S3 clients — reused within a single invocation (parallel presigns)
// and across warm starts (Deno module-level state persists per isolate).
let _b2PrimaryClient: S3Client | null = null;
let _b2SecondaryClient: S3Client | null = null;

function getB2PrimaryClient(): S3Client {
  if (!_b2PrimaryClient) {
    _b2PrimaryClient = new S3Client({
      endpoint: Deno.env.get("B2_ENDPOINT")!,
      region: Deno.env.get("B2_REGION") || "us-west-004",
      credentials: {
        accessKeyId: Deno.env.get("B2_KEY_ID")!,
        secretAccessKey: Deno.env.get("B2_APP_KEY")!,
      },
      forcePathStyle: true,
      // B2 rejects presigned URLs that carry unsigned x-amz-checksum-* query
      // params, which the AWS SDK injects by default on newer versions. These
      // options force checksums to be computed only when the operation requires
      // them, keeping PutObject presigned URLs clean. Without this, every
      // upload signed via this function fails with SignatureDoesNotMatch.
      // @ts-ignore — options recognised at runtime, not in older type defs
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2PrimaryClient;
}

function getB2SecondaryClient(): S3Client {
  if (!_b2SecondaryClient) {
    _b2SecondaryClient = new S3Client({
      endpoint: Deno.env.get("B2_SECONDARY_ENDPOINT")!,
      region: Deno.env.get("B2_SECONDARY_REGION") || "us-west-004",
      credentials: {
        accessKeyId: Deno.env.get("B2_SECONDARY_KEY_ID")!,
        secretAccessKey: Deno.env.get("B2_SECONDARY_APP_KEY")!,
      },
      forcePathStyle: true,
      // See getB2PrimaryClient: required to keep PutObject presigned URLs
      // B2-compatible on AWS SDK v3.693.0+ / v3.1085.0+.
      // @ts-ignore — options recognised at runtime, not in older type defs
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2SecondaryClient;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authHeader = req.headers.get("Authorization");
    const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
      global: { headers: authHeader ? { Authorization: authHeader } : {} },
    });
    const db = createClient<Database>(supabaseUrl, serviceRoleKey);

    const { data: { user } } = authHeader
      ? await supabase.auth.getUser()
      : { data: { user: null } };
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
    if (
      !profile || !["admin", "root", "user"].includes(profile.user_type ?? "")
    ) {
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

    const activeTier = Deno.env.get("ACTIVE_B2_TIER") === "secondary"
      ? "secondary"
      : "primary";

    if (
      activeTier === "secondary" && Deno.env.get("B2_SECONDARY_ENDPOINT") &&
      Deno.env.get("B2_SECONDARY_BUCKET_NAME")
    ) {
      const command = new PutObjectCommand({
        Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
        Key: filename,
        ContentType: contentType || "application/octet-stream",
      });

      const url = await getSignedUrl(getB2SecondaryClient(), command, {
        expiresIn: 3600,
      });

      return new Response(
        JSON.stringify({ url, provider_prefix: "b2-secondary://" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } else if (Deno.env.get("B2_ENDPOINT") && Deno.env.get("B2_BUCKET_NAME")) {
      const command = new PutObjectCommand({
        Bucket: Deno.env.get("B2_BUCKET_NAME")!,
        Key: filename,
        ContentType: contentType || "application/octet-stream",
      });

      const url = await getSignedUrl(getB2PrimaryClient(), command, {
        expiresIn: 3600,
      });

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

      return new Response(
        JSON.stringify({ url: data.signedUrl, provider_prefix: "supabase://" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error("[upload-presign] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
