import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let _b2PrimaryClient: S3Client | null = null;
let _b2SecondaryClient: S3Client | null = null;
let _b2TertiaryClient: S3Client | null = null;

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
      // @ts-ignore
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2SecondaryClient;
}

function getB2TertiaryClient(): S3Client {
  if (!_b2TertiaryClient) {
    _b2TertiaryClient = new S3Client({
      endpoint: Deno.env.get("B2_TERTIARY_ENDPOINT")!,
      region: Deno.env.get("B2_TERTIARY_REGION") || "us-west-004",
      credentials: {
        accessKeyId: Deno.env.get("B2_TERTIARY_KEY_ID")!,
        secretAccessKey: Deno.env.get("B2_TERTIARY_APP_KEY")!,
      },
      forcePathStyle: true,
      // @ts-ignore
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2TertiaryClient;
}

export async function presignUpload(
  supabase: any,
  filename: string,
  contentType?: string,
): Promise<{ url: string; provider_prefix: string }> {
  if (!filename) {
    throw new Error("Filename is required");
  }

  const tier = Deno.env.get("ACTIVE_B2_TIER");
  const activeTier = tier === "tertiary"
    ? "tertiary"
    : tier === "secondary"
    ? "secondary"
    : "primary";

  if (
    activeTier === "tertiary" && Deno.env.get("B2_TERTIARY_ENDPOINT") &&
    Deno.env.get("B2_TERTIARY_BUCKET_NAME")
  ) {
    const command = new PutObjectCommand({
      Bucket: Deno.env.get("B2_TERTIARY_BUCKET_NAME")!,
      Key: filename,
      ContentType: contentType || "application/octet-stream",
    });
    const url = await getSignedUrl(getB2TertiaryClient(), command, {
      expiresIn: 3600,
    });
    return { url, provider_prefix: "b2-tertiary://" };
  } else if (
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
    return { url, provider_prefix: "b2-secondary://" };
  } else if (Deno.env.get("B2_ENDPOINT") && Deno.env.get("B2_BUCKET_NAME")) {
    const command = new PutObjectCommand({
      Bucket: Deno.env.get("B2_BUCKET_NAME")!,
      Key: filename,
      ContentType: contentType || "application/octet-stream",
    });
    const url = await getSignedUrl(getB2PrimaryClient(), command, {
      expiresIn: 3600,
    });
    return { url, provider_prefix: "b2://" };
  } else {
    const { data, error } = await supabase.storage
      .from("audio-files")
      .createSignedUploadUrl(filename, { upsert: true });

    if (error || !data?.signedUrl) {
      throw new Error(`Supabase presign error: ${error?.message}`);
    }

    return { url: data.signedUrl, provider_prefix: "supabase://" };
  }
}
