/* ============================================================================
 * UPLOAD PRESIGN — WITH SINGLE CONFIG SOURCE OF TRUTH
 *
 * PURPOSE: Presigns uploads to the intelligent B2 bucket pool (primary →
 * secondary → tertiary → quartet → quinta). All bucket configuration now
 * comes from the single source of truth in b2-config.ts, eliminating the
 * scattered env-read pattern that previously existed in import_missing_books.ts
 * and other scripts.
 *
 * KEY IMPROVEMENTS vs previous version:
 *   - Config from b2-config.ts single source (not scattered TIER_ENV maps)
 *   - Health-aware bucket selection (was blind primary-first before)
 *   - B2_QUINTET tier now included in fallback chain
 *   - Type-safe tier operations via isTierConfigured / getConfig
 * ========================================================================== */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  bucketHealth,
  getB2Client,
  getBucketName,
  healthCheckBuckets,
  selectBucket,
} from "./b2-bucket-pool.ts";
import type { BucketHealth, BucketTier } from "./b2-types.ts";
import { tierToPrefix } from "./storage-router.ts";

/* -------------------------------------------------------------------------
 * Create an S3 client for a tier using the bucketConfigs from b2-bucket-pool.ts.
 * This correctly maps tier names (B2_QUINTET) to env vars (B2_QUINTA_*) without
 * trying to construct env var names dynamically from tier names. The mapping is
 * now defined once in b2-config.ts and imported here.
 * ------------------------------------------------------------------------- */

function getOrCreateClient(tier: BucketTier): S3Client {
  return getB2Client(tier);
}

/* -------------------------------------------------------------------------
 * Presign an upload using the intelligent bucket pool selection.
 * Automatically selects the best available bucket from the pool (primary →
 * secondary → tertiary → quartet → quinta) using health-aware strategy.
 *
 * FALLBACK CHAIN (health-gated):
 *   B2_SECONDARY → B2_TERTIARY → B2_QUARTET → B2_QUINTET
 *
 * Each tier is checked for health before attempting. If a tier is not
 * configured or is unhealthy, it's skipped automatically.
 * ------------------------------------------------------------------------- */

export async function presignUpload(
  _supabase: any,
  filename: string,
  contentType?: string,
): Promise<
  {
    url: string;
    provider_prefix: string;
    bucketTier: BucketTier;
    bucketName: string;
    health: BucketHealth;
  }
> {
  if (!filename) {
    throw new Error("Filename is required");
  }

  /* Run health check to update bucket statuses with real connectivity data */
  await healthCheckBuckets();

  /* Select the best bucket using the pool strategy (health-aware).
   * Default to primary (B2) unless configured otherwise. */
  const { tier, config: _config, health } = selectBucket("B2");

  const client = getOrCreateClient(tier);
  const bucketName = getBucketName(tier);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: filename,
    ContentType: contentType || "application/octet-stream",
  });

  try {
    const url = await getSignedUrl(client, command, {
      expiresIn: 3600,
    });

    return {
      url,
      provider_prefix: tierToPrefix(tier),
      bucketTier: tier,
      bucketName,
      health,
    };
  } catch (error) {
    /* If primary (B2) fails, try fallback buckets in health-gated chain */
    const fallbackChain: BucketTier[] = [
      "B2_SECONDARY",
      "B2_TERTIARY",
      "B2_QUARTET",
      "B2_QUINTET",
    ];
    let lastError: Error | string = error instanceof Error
      ? error
      : new Error(String(error));

    for (const fallbackTier of fallbackChain) {
      /* Health gate: skip unhealthy or unconfigured tiers */
      const fallbackHealth = bucketHealth.getHealth(fallbackTier);
      if (!fallbackHealth.isHealthy) {
        // @ts-ignore — runtime log suppression
        // console.log(`Skipping fallback to ${fallbackTier} — unhealthy (errors: ${fallbackHealth.errorCount})`);
        continue;
      }

      try {
        const fallbackClient = getOrCreateClient(fallbackTier);
        const fallbackBucketName = getBucketName(fallbackTier);

        const command = new PutObjectCommand({
          Bucket: fallbackBucketName,
          Key: filename,
          ContentType: contentType || "application/octet-stream",
        });

        const url = await getSignedUrl(fallbackClient, command, {
          expiresIn: 3600,
        });

        /* Record success on fallback bucket */
        bucketHealth.recordSuccess(fallbackTier, 0);

        return {
          url,
          provider_prefix: tierToPrefix(fallbackTier),
          bucketTier: fallbackTier as BucketTier,
          bucketName,
          health: bucketHealth.getHealth(fallbackTier),
        };
      } catch (fallbackError) {
        lastError = fallbackError instanceof Error
          ? fallbackError
          : new Error(String(fallbackError));
        // @ts-ignore — runtime log suppression
        // console.log(`Upload fallback to ${fallbackTier} failed:`, fallbackError);
        continue;
      }
    }

    /* If all fallbacks failed, throw the last error */
    throw new Error(
      `Failed to presign upload: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
