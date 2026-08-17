/**
 * Manual one-off: applies CORS rules to every configured B2 bucket
 * (`audiobookphile-b2-tertiary`, `audiobookphile-b2-secondary`, primary) via
 * the S3-compatible API.
 *
 * This script is NOT wired into CI/CD or any package.json script. The bucket
 * CORS it configures is already live in production (verified via preflight:
 * `OPTIONS` returns `access-control-allow-origin: https://audiobookphile.vercel.app`).
 * Re-run this only if CORS is accidentally removed from a bucket, or when
 * adding a new origin.
 *
 * Usage:
 *   cd audiobookphile-backend
 *   deno run --allow-env --allow-net set_cors.ts
 *
 * Requires the B2_* / B2_SECONDARY_* / B2_TERTIARY_* env vars (see .env).
 * A tier is skipped when its env vars are blank.
 *
 * For key rotation (a separate concern), see scripts/ROTATE_B2_KEYS.md.
 */
import { PutBucketCorsCommand, S3Client } from "npm:@aws-sdk/client-s3@^3.0.0";

const CORS_RULES = [
  {
    AllowedHeaders: ["*"],
    AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
    AllowedOrigins: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3000,
  },
];

function tierConfigured(prefix: string): boolean {
  return !!Deno.env.get(`${prefix}_ENDPOINT`) &&
    !!Deno.env.get(`${prefix}_BUCKET_NAME`) &&
    !!Deno.env.get(`${prefix}_KEY_ID`) &&
    !!Deno.env.get(`${prefix}_APP_KEY`);
}

function applyCors(prefix: string): Promise<unknown> {
  const s3Client = new S3Client({
    endpoint: Deno.env.get(`${prefix}_ENDPOINT`)!,
    region: Deno.env.get(`${prefix}_REGION`) || "us-west-004",
    credentials: {
      accessKeyId: Deno.env.get(`${prefix}_KEY_ID`)!,
      secretAccessKey: Deno.env.get(`${prefix}_APP_KEY`)!,
    },
    forcePathStyle: true,
  });
  const params = {
    Bucket: Deno.env.get(`${prefix}_BUCKET_NAME`)!,
    CORSConfiguration: { CORSRules: CORS_RULES },
  };
  return s3Client.send(new PutBucketCorsCommand(params));
}

const encoder = new TextEncoder();

function log(line: string) {
  Deno.stdout.writeSync(encoder.encode(line + "\n"));
}

async function setCors() {
  const tiers = ["B2_TERTIARY", "B2_SECONDARY", "B2"];
  for (const prefix of tiers) {
    if (!tierConfigured(prefix)) {
      log(`Skipping ${prefix}: env vars not set.`);
      continue;
    }
    try {
      await applyCors(prefix);
      log(`Success! CORS rules set for ${prefix}.`);
    } catch (err) {
      log(`Error setting CORS for ${prefix}: ${err}`);
    }
  }
}

setCors();
