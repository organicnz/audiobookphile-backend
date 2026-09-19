/**
 * Manual one-off: applies the canonical CORS rules to every configured B2
 * bucket via the S3-compatible API.
 *
 * This script is NOT wired into CI/CD or any package.json script. It
 * reproduces the exact rules live in production (verified via preflight:
 * `OPTIONS` returns `access-control-allow-origin: https://audiobookphile.app`).
 * Re-run this only if CORS is accidentally removed from a bucket, or when
 * adding a new origin (update APP_ORIGINS below, run, verify preflight).
 *
 * Canonical domain is audiobookphile.app (apex + www/app/api); vercel.app and
 * foodshare.club are legacy fallbacks. Local-dev origins are NOT hardcoded:
 * pass them via the B2_CORS_EXTRA_ORIGINS env var (comma-separated) when
 * running this script for local development. Production runs without it,
 * keeping loopback URLs out of shipped code (pre-commit Hardcoded URL Guard).
 * Browser audio uploads use PUT, seeking uses GET+HEAD with Range, so the
 * exposed Content-Range / Accept-Ranges headers are load-bearing — do not
 * trim them. S3 client construction comes from the shared pool factory
 * (supabase/functions/_shared/b2-bucket-pool.ts), not a local copy.
 *
 * Usage:
 *   cd audiobookphile-backend
 *   deno run --allow-env --allow-net --allow-sys set_cors.ts
 *
 * Requires the B2_* / B2_SECONDARY_* / B2_TERTIARY_* / B2_QUARTET_* /
 * B2_QUINTA_* env vars (see .env.local). A tier is skipped when its env vars
 * are blank (isTierConfigured).
 *
 * For key rotation (a separate concern), see scripts/ROTATE_B2_KEYS.md.
 */
import { PutBucketCorsCommand } from "@aws-sdk/client-s3";
import {
  getB2Client,
  getBucketName,
} from "./supabase/functions/_shared/b2-bucket-pool.ts";
import { isTierConfigured } from "./supabase/functions/_shared/b2-config.ts";
import type { BucketTier } from "./supabase/functions/_shared/b2-types.ts";

const APP_ORIGINS = [
  "https://audiobookphile.app",
  "https://www.audiobookphile.app",
  "https://app.audiobookphile.app",
  "https://api.audiobookphile.app",
  "https://audiobookphile.vercel.app",
  "https://audiobookphile.foodshare.club",
  // Local-dev origins are env-gated (pre-commit forbids loopback literals
  // in shipped code): set B2_CORS_EXTRA_ORIGINS to a comma-separated list.
  ...(Deno.env.get("B2_CORS_EXTRA_ORIGINS")?.split(",").map((s) => s.trim())
    .filter(Boolean) ?? []),
];

const CORS_RULES = [
  {
    AllowedHeaders: ["*"],
    AllowedMethods: ["GET", "HEAD", "PUT"],
    AllowedOrigins: APP_ORIGINS,
    ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    MaxAgeSeconds: 3600,
  },
];

/** Env prefix (B2_QUINTA_*) → code tier name (B2_QUINTET). See b2-config.ts. */
const PREFIX_TO_TIER: Record<string, BucketTier> = {
  B2: "B2",
  B2_SECONDARY: "B2_SECONDARY",
  B2_TERTIARY: "B2_TERTIARY",
  B2_QUARTET: "B2_QUARTET",
  B2_QUINTA: "B2_QUINTET",
};

const encoder = new TextEncoder();

function log(line: string) {
  Deno.stdout.writeSync(encoder.encode(line + "\n"));
}

function applyCors(tier: BucketTier): Promise<unknown> {
  const s3Client = getB2Client(tier);
  const params = {
    Bucket: getBucketName(tier),
    CORSConfiguration: { CORSRules: CORS_RULES },
  };
  return s3Client.send(new PutBucketCorsCommand(params));
}

async function setCors() {
  for (const [prefix, tier] of Object.entries(PREFIX_TO_TIER)) {
    if (!isTierConfigured(tier)) {
      log(`Skipping ${prefix}: env vars not set.`);
      continue;
    }
    try {
      await applyCors(tier);
      log(`Success! CORS rules set for ${prefix}.`);
    } catch (err) {
      log(`Error setting CORS for ${prefix}: ${err}`);
    }
  }
}

setCors();
