/* ============================================================================
 * B2 TYPES — Shared type definitions used across the B2 modules.
 *
 * PURPOSE: Centralized type definitions so all modules (_shared/*)
 * import the same types, ensuring compile-time consistency and
 * eliminating the drift that occurs when types are defined separately
 * in each file.
 *
 * EXPORTS:
 *   - BucketTier: Union type of all 5 bucket tier names
 *   - BucketConfig: Per-tier config interface
 *   - BucketHealth: Health tracking interface
 * ------------------------------------------------------------------------- */

export type BucketTier =
  | "B2"
  | "B2_SECONDARY"
  | "B2_TERTIARY"
  | "B2_QUARTET"
  | "B2_QUINTET";

export interface BucketConfig {
  tier: BucketTier;
  keyId: string;
  appKey: string;
  endpoint: string;
  region: string;
  bucketName: string;
  isConfigured: boolean;
}

export interface BucketHealth {
  tier: BucketTier;
  lastSuccess: number | null; // unix timestamp
  lastError: number | null; // unix timestamp
  errorCount: number;
  successCount: number;
  avgLatency: number; // milliseconds
  isHealthy: boolean;
}
