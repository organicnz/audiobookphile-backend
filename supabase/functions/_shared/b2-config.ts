/* ============================================================================
 * B2 BUCKET CONFIGURATION — SINGLE SOURCE OF TRUTH
 *
 * PURPOSE: Centralized bucket tier configuration eliminated the 5+ scattered
 * config sources that previously existed across the codebase. All modules now
 * import from this single file, guaranteeing config consistency and enabling
 * compile-time validation of bucket tier readiness.
 *
 * TIER NAMING CONVENTION (CRITICAL):
 *   - Code tier names: B2, B2_SECONDARY, B2_TERTIARY, B2_QUARTET, B2_QUINTET
 *   - Env var prefixes: B2_, B2_SECONDARY_, B2_TERTIARY_, B2_QUARTET_, B2_QUINTA_
 *   - DISTINCTION: B2_QUINTET (code name) vs B2_QUINTA (env var prefix)
 *   - This is the most common gotcha — never confuse the code name with the
 *     environment variable prefix. The code uses the tier name; callers use
 *     the env var prefix when looking up secrets.
 * ========================================================================== */

import { BucketConfig, BucketTier } from "./b2-types.ts";

/* -------------------------------------------------------------------------
 * Helper: ensure B2 endpoints use the S3-compatible API endpoint format.
 * https://api.backblazeb2.com is Native B2 JSON, while AWS SDK requires
 * https://s3.<region>.backblazeb2.com.
 * ------------------------------------------------------------------------- */
function resolveS3Endpoint(
  endpoint?: string,
  region: string = "us-west-004",
): string {
  if (!endpoint || endpoint.includes("api.backblazeb2.com")) {
    return `https://s3.${region}.backblazeb2.com`;
  }
  return endpoint;
}

const bucketConfigs: Record<BucketTier, BucketConfig> = {
  B2: {
    tier: "B2" as const,
    keyId: Deno.env.get("B2_KEY_ID")!,
    appKey: Deno.env.get("B2_APP_KEY")!,
    endpoint: resolveS3Endpoint(
      Deno.env.get("B2_ENDPOINT"),
      Deno.env.get("B2_REGION") || "us-west-004",
    ),
    region: Deno.env.get("B2_REGION") || "us-west-004",
    bucketName: Deno.env.get("B2_BUCKET_NAME")!,
    isConfigured: !!Deno.env.get("B2_KEY_ID") &&
      !!Deno.env.get("B2_BUCKET_NAME"),
  },
  B2_SECONDARY: {
    tier: "B2_SECONDARY" as const,
    keyId: Deno.env.get("B2_SECONDARY_KEY_ID")!,
    appKey: Deno.env.get("B2_SECONDARY_APP_KEY")!,
    endpoint: resolveS3Endpoint(
      Deno.env.get("B2_SECONDARY_ENDPOINT"),
      Deno.env.get("B2_SECONDARY_REGION") || "us-west-004",
    ),
    region: Deno.env.get("B2_SECONDARY_REGION") || "us-west-004",
    bucketName: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
    isConfigured: !!Deno.env.get("B2_SECONDARY_KEY_ID") &&
      !!Deno.env.get("B2_SECONDARY_BUCKET_NAME"),
  },
  B2_TERTIARY: {
    tier: "B2_TERTIARY" as const,
    keyId: Deno.env.get("B2_TERTIARY_KEY_ID")!,
    appKey: Deno.env.get("B2_TERTIARY_APP_KEY")!,
    endpoint: resolveS3Endpoint(
      Deno.env.get("B2_TERTIARY_ENDPOINT"),
      Deno.env.get("B2_TERTIARY_REGION") || "us-west-004",
    ),
    region: Deno.env.get("B2_TERTIARY_REGION") || "us-west-004",
    bucketName: Deno.env.get("B2_TERTIARY_BUCKET_NAME")!,
    isConfigured: !!Deno.env.get("B2_TERTIARY_KEY_ID") &&
      !!Deno.env.get("B2_TERTIARY_BUCKET_NAME"),
  },
  B2_QUARTET: {
    tier: "B2_QUARTET" as const,
    keyId: Deno.env.get("B2_QUARTET_KEY_ID")!,
    appKey: Deno.env.get("B2_QUARTET_APP_KEY")!,
    endpoint: resolveS3Endpoint(
      Deno.env.get("B2_QUARTET_ENDPOINT"),
      Deno.env.get("B2_QUARTET_REGION") || "us-west-004",
    ),
    region: Deno.env.get("B2_QUARTET_REGION") || "us-west-004",
    bucketName: Deno.env.get("B2_QUARTET_BUCKET_NAME")!,
    isConfigured: !!Deno.env.get("B2_QUARTET_KEY_ID") &&
      !!Deno.env.get("B2_QUARTET_BUCKET_NAME"),
  },
  B2_QUINTET: {
    tier: "B2_QUINTET" as const,
    keyId: Deno.env.get("B2_QUINTA_KEY_ID")!,
    appKey: Deno.env.get("B2_QUINTA_APP_KEY")!,
    endpoint: resolveS3Endpoint(
      Deno.env.get("B2_QUINTA_ENDPOINT"),
      Deno.env.get("B2_QUINTA_REGION") || "us-west-004",
    ),
    region: Deno.env.get("B2_QUINTA_REGION") || "us-west-004",
    bucketName: Deno.env.get("B2_QUINTA_BUCKET_NAME")!,
    isConfigured: !!Deno.env.get("B2_QUINTA_KEY_ID") &&
      !!Deno.env.get("B2_QUINTA_BUCKET_NAME"),
  },
};

/* -------------------------------------------------------------------------
 * Frozen config object — no mutations allowed after module load.
 * Using Object.freeze prevents runtime config drift, the #1 cause of
 * production bugs when env vars are accidentally deleted or changed.
 * ------------------------------------------------------------------------- */

export const BUCKET_CONFIGS = Object.freeze(bucketConfigs);

/* -------------------------------------------------------------------------
 * Human-readable tier labels for logging and error messages.
 * Kept in sync with BUCKET_Tiers above.
 * ------------------------------------------------------------------------- */

export const BUCKET_Tiers = [
  "B2",
  "B2_SECONDARY",
  "B2_TERTIARY",
  "B2_QUARTET",
  "B2_QUINTET",
] as const;

/* -------------------------------------------------------------------------
 * Type-safe tier check — ensures only valid tier names are used.
 * Usage: if (!isBucketTier(tier)) throw new Error("Invalid tier");
 * ------------------------------------------------------------------------- */

export const isBucketTier = (
  value: string,
): value is BucketTier => BUCKET_Tiers.includes(value as BucketTier);

/* -------------------------------------------------------------------------
 * Config readiness check — fast boolean check for CI/CD and runtime guards.
 * Usage: if (!isTierConfigured("B2_QUINTET")) skipQuintaOperations();
 * ------------------------------------------------------------------------- */

export const isTierConfigured = (
  tier: BucketTier,
): boolean => BUCKET_CONFIGS[tier]?.isConfigured ?? false;

/* -------------------------------------------------------------------------
 * Safe config retrieval — throws descriptive error if tier not configured.
 * Prefer over direct BUCKET_CONFIGS[tier] access which would give obscure
 * undefined errors at 3am production debugging time.
 * ------------------------------------------------------------------------- */

export const getConfig = (
  tier: BucketTier,
): BucketConfig => {
  const config = BUCKET_CONFIGS[tier];
  if (!config) {
    const validTiers = BUCKET_Tiers.join(", ");
    throw new Error(
      `Invalid bucket tier: "${tier}". Valid tiers: ${validTiers}`,
    );
  }
  if (!config.isConfigured) {
    throw new Error(
      `Bucket tier "${tier}" is not configured — missing B2_* environment variables. ` +
        `Set the following in Supabase secrets or .env.local:\n` +
        `  keyId: ${
          tier === "B2_QUINTET" ? "B2_QUINTA_KEY_ID" : `${tier}_KEY_ID`
        }\n` +
        `  appKey: ${
          tier === "B2_QUINTET" ? "B2_QUINTA_APP_KEY" : `${tier}_APP_KEY`
        }\n` +
        `  endpoint: ${
          tier === "B2_QUINTET" ? "B2_QUINTA_ENDPOINT" : `${tier}_ENDPOINT`
        }\n` +
        `  bucketName: ${
          tier === "B2_QUINTET"
            ? "B2_QUINTA_BUCKET_NAME"
            : `${tier}_BUCKET_NAME`
        }\n`,
    );
  }
  return config;
};
