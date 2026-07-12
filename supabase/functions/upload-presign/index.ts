import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { corsHeaders } from "../_shared/cors.ts";
import { Database } from "../../../src/types/supabase.ts";

// 50 MB chunk size for multipart uploads
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

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
      // @ts-ignore
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
    });
  }
  return _b2SecondaryClient;
}

async function handleMultipartPresign(
  s3Client: S3Client,
  bucket: string,
  key: string,
  contentType: string,
  fileSize: number,
  providerPrefix: string,
): Promise<Response> {
  // Initiate multipart upload
  const createCmd = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  const { UploadId } = await s3Client.send(createCmd);

  // Generate a presigned URL for each part
  const partCount = Math.ceil(fileSize / PART_SIZE);
  const partUrls: string[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const partCmd = new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId,
      PartNumber: partNumber,
    });
    const url = await getSignedUrl(s3Client, partCmd, { expiresIn: 3600 });
    partUrls.push(url);
  }

  return new Response(
    JSON.stringify({
      multipart: true,
      uploadId: UploadId,
      partUrls,
      partSize: PART_SIZE,
      provider_prefix: providerPrefix,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

async function handleCompleteMultipart(
  s3Client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
): Promise<Response> {
  const cmd = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  });
  await s3Client.send(cmd);
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

    const body = await req.json();
    const { filename, contentType, size, action } = body;

    if (!filename) {
      return new Response(JSON.stringify({ error: "Filename is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const activeTier = Deno.env.get("ACTIVE_B2_TIER") === "secondary"
      ? "secondary"
      : "primary";

    const isB2Secondary = activeTier === "secondary" &&
      Deno.env.get("B2_SECONDARY_ENDPOINT") &&
      Deno.env.get("B2_SECONDARY_BUCKET_NAME");
    const isB2Primary = !isB2Secondary && Deno.env.get("B2_ENDPOINT") &&
      Deno.env.get("B2_BUCKET_NAME");

    // Handle complete-multipart action
    if (action === "complete-multipart") {
      const { uploadId, parts } = body;
      if (!uploadId || !parts) {
        return new Response(
          JSON.stringify({ error: "uploadId and parts required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (isB2Secondary) {
        return await handleCompleteMultipart(
          getB2SecondaryClient(),
          Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
          filename,
          uploadId,
          parts,
        );
      } else if (isB2Primary) {
        return await handleCompleteMultipart(
          getB2PrimaryClient(),
          Deno.env.get("B2_BUCKET_NAME")!,
          filename,
          uploadId,
          parts,
        );
      }
      return new Response(
        JSON.stringify({ error: "No B2 storage configured" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // For B2 uploads: use multipart if file exceeds threshold
    const fileSize = typeof size === "number" ? size : 0;
    const useMultipart = fileSize > MULTIPART_THRESHOLD;

    if (isB2Secondary) {
      const bucket = Deno.env.get("B2_SECONDARY_BUCKET_NAME")!;

      if (useMultipart) {
        return await handleMultipartPresign(
          getB2SecondaryClient(),
          bucket,
          filename,
          contentType || "application/octet-stream",
          fileSize,
          "b2-secondary://",
        );
      }

      const command = new PutObjectCommand({
        Bucket: bucket,
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
    } else if (isB2Primary) {
      const bucket = Deno.env.get("B2_BUCKET_NAME")!;

      if (useMultipart) {
        return await handleMultipartPresign(
          getB2PrimaryClient(),
          bucket,
          filename,
          contentType || "application/octet-stream",
          fileSize,
          "b2://",
        );
      }

      const command = new PutObjectCommand({
        Bucket: bucket,
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
    console.error("[upload-presign] Error:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
