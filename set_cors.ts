/**
 * Manual one-off: applies CORS rules to the `audiobookphile-b2-secondary`
 * bucket via the S3-compatible API.
 *
 * This script is NOT wired into CI/CD or any package.json script. The bucket
 * CORS it configures is already live in production (verified via preflight:
 * `OPTIONS` returns `access-control-allow-origin: https://audiobookphile.vercel.app`).
 * Re-run this only if CORS is accidentally removed from the bucket, or when
 * adding a new origin.
 *
 * Usage:
 *   cd audiobookphile-backend
 *   deno run --allow-env --allow-net set_cors.ts
 *
 * Requires the B2_SECONDARY_* env vars (see .env).
 *
 * For key rotation (a separate concern), see scripts/ROTATE_B2_KEYS.md.
 */
import { PutBucketCorsCommand, S3Client } from "npm:@aws-sdk/client-s3@^3.0.0";

const s3Client = new S3Client({
  endpoint: Deno.env.get("B2_SECONDARY_ENDPOINT")!,
  region: Deno.env.get("B2_SECONDARY_REGION") || "us-west-004",
  credentials: {
    accessKeyId: Deno.env.get("B2_SECONDARY_KEY_ID")!,
    secretAccessKey: Deno.env.get("B2_SECONDARY_APP_KEY")!,
  },
  forcePathStyle: true,
});

async function setCors() {
  const params = {
    Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
          AllowedOrigins: ["*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  };
  try {
    const data = await s3Client.send(new PutBucketCorsCommand(params));
    console.log("Success! CORS rules set.", data);
  } catch (err) {
    console.log("Error", err);
  }
}

setCors();
