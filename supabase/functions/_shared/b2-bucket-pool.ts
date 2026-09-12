/* ============================================================================
 * B2 BUCKET POOL MANAGER — WITH SINGLE CONFIG SOURCE OF TRUTH
 *
 * PURPOSE: Manages the 5-tier B2 bucket pool (primary, secondary, tertiary,
 * quartet, quinta) with health tracking, fallback chains, and intelligent
 * bucket selection. All bucket configuration now comes from the single
 * source of truth in b2-config.ts — eliminating the 5+ scattered config
 * sources that previously existed.
 *
 * KEY IMPROVEMENTS vs previous version:
 *   - Config from b2-config.ts (single source of truth, not scattered env reads)
 *   - Real health check connectivity tests (was simulated before)
 *   - Graceful fallback chains with health gating
 *   - Type-safe tier operations via isBucketTier / isTierConfigured
 * ========================================================================== */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl as _getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient as _createClient } from "npm:@supabase/supabase-js@2.44.0";

import {
  BUCKET_CONFIGS,
  BUCKET_Tiers,
  getConfig,
  isTierConfigured,
} from "./b2-config.ts";
import type { BucketConfig, BucketHealth, BucketTier } from "./b2-types.ts";
export type { BucketConfig, BucketHealth, BucketTier } from "./b2-types.ts";
import { HeadObjectCommand } from "npm:@aws-sdk/client-s3@^3.693.0";

/* -------------------------------------------------------------------------
 * Singleton health tracker — shared across all function invocations within
 * a single edge function process. Each new invocation gets a fresh process,
 * so health state doesn't persist across requests (by design — prevents
 * stale state from long-running processes).
 * ------------------------------------------------------------------------- */

class BucketHealthTracker {
  private health: Map<BucketTier, BucketHealth>;

  constructor() {
    this.health = new Map();

    /* Initialize all tiers with default healthy state from single config */
    for (const tier of BUCKET_Tiers) {
      const config = BUCKET_CONFIGS[tier];
      /* If tier not configured, mark unhealthy so fallback logic skips it */
      const initializedHealth: BucketHealth = {
        tier,
        lastSuccess: null,
        lastError: null,
        errorCount: config?.isConfigured ? 0 : 999, // force skip if not configured
        successCount: 0,
        avgLatency: 0,
        isHealthy: config?.isConfigured ?? false,
      };
      this.health.set(tier, initializedHealth);
    }
  }

  /* Record a successful operation to a bucket tier */
  recordSuccess(tier: BucketTier, latency: number) {
    /* Type-safe: tier is already BucketTier from the type system */
    const entry = this.health.get(tier)!;
    entry.lastSuccess = Date.now();
    entry.successCount++;
    /* Update moving average latency (EMA: 90% old + 10% new) */
    entry.avgLatency = entry.avgLatency * 0.9 + latency * 0.1;
    /* Mark healthy if error count is low */
    entry.isHealthy = entry.errorCount < 5;
  }

  /* Record a failed operation to a bucket tier */
  recordError(tier: BucketTier, latency: number, isFatal: boolean = false) {
    /* Type-safe */
    const entry = this.health.get(tier)!;
    entry.lastError = Date.now();
    entry.errorCount++;
    /* Update moving average latency */
    entry.avgLatency = entry.avgLatency * 0.9 + latency * 0.1;
    /* Mark unhealthy if fatal (healthcheck failure) or too many errors */
    entry.isHealthy = !isFatal && entry.errorCount < 3;
  }

  /* Get health status for a specific tier */
  getHealth(tier: BucketTier): BucketHealth {
    return this.health.get(tier)!;
  }

  /* Get health status for all tiers */
  getAllHealth(): Map<BucketTier, BucketHealth> {
    return new Map(this.health);
  }
}

/* -------------------------------------------------------------------------
 * Singleton instance — shared across all functions within one edge process.
 * Exported as `bucketHealth` for use by uploadPresign.ts, storage-router.ts, etc.
 * ------------------------------------------------------------------------- */
export const bucketHealth = new BucketHealthTracker();

/* -------------------------------------------------------------------------
 * Core bucket selection logic — uses health-aware fallback chain.
 * Strategy:
 *   1. If forceFallover=true: skip health checks, go down the chain
 *   2. If primary B2 is healthy: use it (with round-robin awareness)
 *   3. If primary unhealthy: fall through to secondary, tertiary, quartet, quinta
 *   4. If no bucket healthy: return primary anyway (best-effort)
 * ------------------------------------------------------------------------- */

export function selectBucket(
  preferredTier?: BucketTier,
  forceFallover: boolean = false,
): { tier: BucketTier; config: BucketConfig; health: BucketHealth } {
  const allHealth = bucketHealth.getAllHealth();

  // 1. Resolve requested tier from argument or ACTIVE_B2_TIER environment variable
  let requestedTier: BucketTier | undefined = preferredTier;
  if (!requestedTier) {
    const envTier = (Deno.env.get("ACTIVE_B2_TIER") || "").toUpperCase();
    if (
      envTier === "QUINTA" || envTier === "B2_QUINTA" ||
      envTier === "B2_QUINTET"
    ) {
      requestedTier = "B2_QUINTET";
    } else if (envTier === "TERTIARY" || envTier === "B2_TERTIARY") {
      requestedTier = "B2_TERTIARY";
    } else if (envTier === "SECONDARY" || envTier === "B2_SECONDARY") {
      requestedTier = "B2_SECONDARY";
    } else if (envTier === "QUARTET" || envTier === "B2_QUARTET") {
      requestedTier = "B2_QUARTET";
    } else if (envTier === "PRIMARY" || envTier === "B2") {
      requestedTier = "B2";
    }
  }

  // If requested tier is explicitly set, configured, and healthy, prioritize it
  if (!forceFallover && requestedTier && isTierConfigured(requestedTier)) {
    const health = allHealth.get(requestedTier)!;
    if (health?.isHealthy) {
      return { tier: requestedTier, config: getConfig(requestedTier), health };
    }
  }

  // Priority search chain: prioritize verified active tiers (QUINTET, TERTIARY) then remaining
  const candidateChain: BucketTier[] = [
    "B2_QUINTET",
    "B2_TERTIARY",
    "B2",
    "B2_SECONDARY",
    "B2_QUARTET",
  ];

  for (const tier of candidateChain) {
    if (!isTierConfigured(tier)) continue;
    const health = allHealth.get(tier);
    if (health?.isHealthy) {
      return { tier, config: getConfig(tier), health };
    }
  }

  // If no bucket is marked healthy, fallback to first configured tier
  for (const tier of candidateChain) {
    if (isTierConfigured(tier)) {
      return { tier, config: getConfig(tier), health: allHealth.get(tier)! };
    }
  }

  const primaryHealth = allHealth.get("B2")!;
  return { tier: "B2", config: getConfig("B2"), health: primaryHealth };
}

/* -------------------------------------------------------------------------
 * Get the S3Client for a specific bucket tier.
 * Uses the single config source (getConfig) for type safety and config
 * consistency across all modules. Adds checksum config guards that were
 * critical fixes in the B2_QUINTET refactor.
 * ------------------------------------------------------------------------- */

export function getB2Client(tier: BucketTier): S3Client {
  /* Type-safe config retrieval — throws if tier not configured, fails fast */
  const config = getConfig(tier);

  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.appKey,
    },
    forcePathStyle: true,
    /* Critical B2 fix: checksum config — WHEN_REQUIRED prevents
     * SignatureDoesNotMatch errors on presigned URLs. These options were
     * added during the B2_QUINTET refactor and apply to ALL tiers.
     * @ts-ignore — options recognized at runtime, not in older type defs */
    // @ts-ignore
    requestChecksumCalculation: "WHEN_REQUIRED",
    // @ts-ignore
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/* -------------------------------------------------------------------------
 * Get the bucket name for a specific tier.
 * Uses single config source for consistency.
 * ------------------------------------------------------------------------- */

export function getBucketName(tier: BucketTier): string {
  /* Type-safe — getConfig throws if tier not configured */
  return getConfig(tier).bucketName;
}

/* -------------------------------------------------------------------------
 * Health check all buckets with REAL connectivity testing.
 * PREVIOUS: Always simulated success (latency - Date.now() = 0 or neg).
 * NOW: Actual HEAD request to each bucket to verify connectivity.
 *
 * Called periodically (e.g., every 30 seconds via setInterval in the edge
 * function lifecycle) to keep health state accurate so fallback chains
 * make intelligent decisions.
 * ------------------------------------------------------------------------- */

export async function healthCheckBuckets(): Promise<
  Map<BucketTier, BucketHealth>
> {
  const results = new Map<BucketTier, BucketHealth>();

  for (const tier of BUCKET_Tiers) {
    if (!isTierConfigured(tier)) {
      continue;
    }
    try {
      const client = getB2Client(tier);
      /* Actual connectivity test: HEAD object with a unique key */
      const testKey = `health-check-${tier}-${Date.now()}`;
      const start = Date.now();
      try {
        await client.send(
          new (HeadObjectCommand as any)({
            Bucket: getBucketName(tier)!,
            Key: testKey,
          }),
        );
      } catch (headErr: any) {
        // A 404 (NotFound or NoSuchKey) means the bucket and credentials ARE valid and reachable!
        const isNotFound = headErr?.name === "NotFound" ||
          headErr?.name === "NoSuchKey" ||
          headErr?.$metadata?.httpStatusCode === 404;
        if (!isNotFound) {
          throw headErr;
        }
      }
      const latency = Date.now() - start;

      /* Record success with real latency — this actually tests connectivity */
      bucketHealth.recordSuccess(tier, latency);

      /* Also record in results map for callers */
      results.set(tier, bucketHealth.getHealth(tier));
    } catch (error) {
      console.error(`Health check failed for ${tier}:`, error);
      bucketHealth.recordError(tier, 0, true);
      results.set(tier, bucketHealth.getHealth(tier));
    }
  }

  return results;
}

/* -------------------------------------------------------------------------
 * Upload to the intelligently selected bucket using the pool.
 * Uses selectBucket() for tier selection, getB2Client() for the S3 client,
 * and the health tracker for recording results. Includes automatic fallback
 * to next bucket in chain on upload failure.
 * ------------------------------------------------------------------------- */

export async function uploadToSmartBucket(
  key: string,
  fileData: Uint8Array,
  contentType: string,
  options: { upsert?: boolean } = {},
): Promise<
  {
    success: boolean;
    bucket: BucketTier;
    key: string;
    etag?: string;
    error?: string;
  }
> {
  /* Select the best bucket using the pool strategy (health-aware) */
  const { tier, config: _config, health: _health } = selectBucket();

  const s3Client = getB2Client(tier);
  const bucketName = getBucketName(tier);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileData,
    ContentType: contentType,
    ...options,
  });

  try {
    const startTime = Date.now();
    const { etag: _etag, VersionId: _VersionId } = await s3Client.send(
      command,
    ) as { etag?: string; VersionId: string };
    const latency = Date.now() - startTime;

    /* Record success in health tracker with real latency */
    bucketHealth.recordSuccess(tier, latency);

    return {
      success: true,
      bucket: tier,
      key,
      etag: _etag ?? undefined,
    };
  } catch (error) {
    /* Record error in health tracker */
    bucketHealth.recordError(tier, 0);

    console.error(`Upload to ${tier} bucket failed:`, error);

    /* Try fallback to next bucket in chain */
    const fallbackChain: BucketTier[] = [
      "B2_SECONDARY",
      "B2_TERTIARY",
      "B2_QUARTET",
      "B2_QUINTET",
    ];
    for (const fallbackTier of fallbackChain) {
      /* Check health before attempting fallback */
      const fallbackHealth = bucketHealth.getHealth(fallbackTier);
      if (!fallbackHealth.isHealthy) {
        // @ts-ignore — runtime logging
        // console.log(`Skipping fallback to ${fallbackTier} — bucket unhealthy`);
        continue;
      }

      const fallbackClient = getB2Client(fallbackTier);
      const fallbackBucketName = getBucketName(fallbackTier);

      try {
        await fallbackClient.send(
          new PutObjectCommand({
            Bucket: fallbackBucketName,
            Key: key,
            Body: fileData,
            ContentType: contentType,
            ...options,
          }),
        );

        /* Record success on fallback bucket */
        bucketHealth.recordSuccess(fallbackTier, 0);

        return {
          success: true,
          bucket: fallbackTier as BucketTier,
          key,
        };
      } catch (fallbackError) {
        console.error(
          `Upload fallback to ${fallbackTier} also failed:`,
          fallbackError,
        );
        continue;
      }
    }

    /* All fallbacks failed — return failure */
    return {
      success: false,
      bucket: tier,
      key,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* -------------------------------------------------------------------------
 * EXPORTED TYPES — for external consumers who need type information.
 * ------------------------------------------------------------------------- */
