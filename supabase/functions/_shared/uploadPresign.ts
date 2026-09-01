import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type BucketHealth,
  bucketHealth,
  type BucketTier,
  getB2Client,
  getBucketName,
  healthCheckBuckets,
  selectBucket,
} from "./b2-bucket-pool.ts";

/**
 * Create an S3 client for a tier using the bucketConfigs from b2-bucket-pool.ts.
 * This correctly maps tier names (B2_QUINTET) to env vars (B2_QUINTA_*) without
 * trying to construct env var names dynamically from tier names.
 */
function getOrCreateClient(tier: BucketTier): S3Client {
  return getB2Client(tier);
}

/**
 * Presign an upload using the intelligent bucket pool selection.
 * Automatically selects the best available bucket from the pool (primary → secondary → tertiary → quartet).
 */
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

  // Run health check to update bucket statuses
  await healthCheckBuckets();

  // Select the best bucket using the pool strategy
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
      provider_prefix: `${tier.toLowerCase()}://`,
      bucketTier: tier,
      bucketName,
      health,
    };
  } catch (error) {
    // If primary fails, try fallback buckets in chain
    const fallbackChain = [
      "B2_SECONDARY",
      "B2_TERTIARY",
      "B2_QUARTET",
      "B2_QUINTET",
    ];
    let lastError: Error | string = error instanceof Error
      ? error
      : new Error(String(error));

    for (const fallbackTier of fallbackChain) {
      try {
        const fallbackHealth = bucketHealth.getHealth(fallbackTier);
        if (!fallbackHealth.isHealthy) continue;

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

        // Record success on fallback bucket
        bucketHealth.recordSuccess(fallbackTier, 0);

        return {
          url,
          provider_prefix: `${fallbackTier.toLowerCase()}://`,
          bucketTier: fallbackTier as BucketTier,
          bucketName,
          health: bucketHealth.getHealth(fallbackTier),
        };
      } catch (fallbackError) {
        lastError = fallbackError instanceof Error
          ? fallbackError
          : new Error(String(fallbackError));
        console.error(
          `Upload fallback to ${fallbackTier} failed:`,
          fallbackError,
        );
        continue;
      }
    }

    // If all fallbacks failed, throw the last error
    throw new Error(
      `Failed to presign upload: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
