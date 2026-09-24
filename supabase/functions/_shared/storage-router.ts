/* ============================================================================
 * STORAGE ROUTER — AUDIO IS B2-ONLY (Supabase is covers/light only)
 *
 * PURPOSE: Routes AUDIO storage paths (b2-tertiary://, b2-secondary://,
 * b2-quartet://, b2-quinta://, b2-primary://, b2://) to the correct B2 client.
 * Supabase Storage is NEVER used for audiobooks — only for light assets
 * (covers bucket, author avatars) via direct
 * supabase.storage.from("covers") calls OUTSIDE this router.
 *
 * Probing order: b2-quinta → b2-tertiary → b2-primary → b2-secondary →
 * b2-quartet (matches selectBucket() candidateChain in
 * b2-bucket-pool.ts so uploads and fetch-time resolution agree on priority).
 *
 * KEY IMPROVEMENTS:
 *   - Config from b2-config.ts single source (not scattered env reads)
 *   - Full support for all 5 B2 tiers including B2_QUARTET and B2_QUINTET
 *   - Support for both hyphenated (b2-secondary://) and underscored (b2_secondary://) schemes
 *   - Proactive multi-candidate legacy path resolution
 *   - Real HEAD probes with health-gated fallbacks
 *   - supabase:// audio paths fail fast (legacy mis-write, not a backend)
 * ========================================================================== */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "npm:@aws-sdk/client-s3@^3.693.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@^3.693.0";

import { BucketTier } from "./b2-types.ts";
import {
  getConfig,
  getConfiguredTiers,
  isTierConfigured,
} from "./b2-config.ts";
import { getB2Client } from "./b2-bucket-pool.ts";

/* -------------------------------------------------------------------------
 * Configuration readiness checks.
 * ------------------------------------------------------------------------- */

export function b2QuintaConfigured(): boolean {
  return isTierConfigured("B2_QUINTET");
}

export function b2QuartetConfigured(): boolean {
  return isTierConfigured("B2_QUARTET");
}

export function b2TertiaryConfigured(): boolean {
  return isTierConfigured("B2_TERTIARY");
}

export function b2SecondaryConfigured(): boolean {
  return isTierConfigured("B2_SECONDARY");
}

/* -------------------------------------------------------------------------
 * Canonical Scheme Formatter
 * ------------------------------------------------------------------------- */

export function tierToPrefix(tier: BucketTier | "SUPABASE"): string {
  switch (tier) {
    case "B2_TERTIARY":
      return "b2-tertiary://";
    case "B2_SECONDARY":
      return "b2-secondary://";
    case "B2_QUARTET":
      return "b2-quartet://";
    case "B2_QUINTET":
      return "b2-quinta://";
    case "B2":
      return "b2://";
    case "SUPABASE":
      return "supabase://";
  }
}

export interface ResolvedStoragePath {
  signedUrl: string;
  /** The canonical path with scheme prefix, e.g. "b2-secondary://itemId/file.mp3" */
  canonicalPath: string;
}

export interface ParsedStoragePath {
  tier: BucketTier | "SUPABASE";
  key: string;
  isLegacy?: boolean;
}

export interface StorageDeleteResult {
  status: "deleted" | "absent" | "failed" | "unsupported";
  error?: string;
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const code = String(candidate.name ?? candidate.Code ?? candidate.code ?? "");
  return code === "NotFound" || code === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404;
}

/* -------------------------------------------------------------------------
 * StorageRouter class — main API for all storage path operations.
 * ------------------------------------------------------------------------- */

export class StorageRouter {
  // supabase is retained for constructor compatibility (callers pass their
  // client) but audio paths never touch Supabase storage: audio is B2-only,
  // light assets go through supabase.storage.from("covers") outside this
  // router. Do not remove the param without updating all call sites + tests.
  constructor(private supabase: any) {}

  /**
   * Parse arbitrary path strings (including legacy, underscored, hyphenated) into tier + key.
   */
  parsePath(path: string): ParsedStoragePath | null {
    if (!path || typeof path !== "string") return null;

    if (path.startsWith("supabase://")) {
      return { tier: "SUPABASE", key: path.replace("supabase://", "") };
    }
    if (
      path.startsWith("b2-tertiary://") || path.startsWith("b2_tertiary://")
    ) {
      return {
        tier: "B2_TERTIARY",
        key: path.replace(/^b2[-_]tertiary:\/\//, ""),
      };
    }
    if (
      path.startsWith("b2-secondary://") || path.startsWith("b2_secondary://")
    ) {
      return {
        tier: "B2_SECONDARY",
        key: path.replace(/^b2[-_]secondary:\/\//, ""),
      };
    }
    if (
      path.startsWith("b2-quartet://") ||
      path.startsWith("b2_quartet://") ||
      path.startsWith("b2-quarta://") ||
      path.startsWith("b2_quarta://")
    ) {
      return {
        tier: "B2_QUARTET",
        key: path.replace(/^b2[-_]quart(?:et|a):\/\//, ""),
      };
    }
    if (
      path.startsWith("b2-quinta://") ||
      path.startsWith("b2_quinta://") ||
      path.startsWith("b2-quintet://") ||
      path.startsWith("b2_quintet://")
    ) {
      return {
        tier: "B2_QUINTET",
        key: path.replace(/^b2[-_]quint(?:et|a):\/\//, ""),
      };
    }
    if (
      path.startsWith("b2://") ||
      path.startsWith("b2-primary://") ||
      path.startsWith("b2_primary://") ||
      path.startsWith("s3://")
    ) {
      return {
        tier: "B2",
        key: path
          .replace(/^b2:\/\//, "")
          .replace(/^b2[-_]primary:\/\//, "")
          .replace(/^s3:\/\//, ""),
      };
    }
    if (!path.includes("://")) {
      return { tier: "B2", key: path.replace(/^\/+/, ""), isLegacy: true };
    }
    return null;
  }

  /* -------------------------------------------------------------------
   * getSignedUrl — returns a presigned URL for the given AUDIO storage path.
   * Audio is B2-only. supabase:// audio URIs are a legacy mis-write (audio
   * must never live in Supabase — covers bucket only) and fail fast here
   * instead of hitting the audio-files bucket.
   * ------------------------------------------------------------------- */

  async getSignedUrl(path: string, expiresIn: number): Promise<string> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      throw new Error(`Unsupported storage provider for path: ${path}`);
    }

    if (parsed.tier === "SUPABASE") {
      throw new Error(
        `Audio path "${path}" points at Supabase, but audiobooks are B2-only ` +
          `(Supabase storage is covers/light assets only). Re-upload the file ` +
          `via B2 presign so its metadata.path becomes b2(-tier)://…`,
      );
    }

    if (!isTierConfigured(parsed.tier)) {
      throw new Error(`Bucket tier "${parsed.tier}" is not configured`);
    }

    const client = getB2Client(parsed.tier);
    const command = new GetObjectCommand({
      Bucket: getConfig(parsed.tier).bucketName,
      Key: parsed.key,
    });
    // @ts-ignore
    return await getSignedUrl(client, command, { expiresIn });
  }

  /* -------------------------------------------------------------------
   * resolveAndSign — resolves a legacy path or un-schemed path by probing
   * all candidate keys across all B2 buckets (audio is B2-only).
   * ------------------------------------------------------------------- */

  async resolveAndSign(
    legacyPath: string,
    itemId: string,
    expiresIn: number,
    options: { allowBasenameFallback?: boolean } = {},
  ): Promise<ResolvedStoragePath> {
    const filename = legacyPath.split("/").pop()!;
    const cleanLegacy = legacyPath.replace(/^\/+/, "");
    const candidates = [
      `${itemId}/${filename}`,
      cleanLegacy,
      `audiobooks/${cleanLegacy}`,
      cleanLegacy.replace(/^audiobooks\//, ""),
      ...(options.allowBasenameFallback === false ? [] : [filename]),
    ].filter(Boolean);

    const uniqueCandidates = Array.from(new Set(candidates));
    const resolved = await this.signFirstExisting(uniqueCandidates, expiresIn);
    if (resolved) {
      return resolved;
    }

    throw new Error(
      `File not found in any B2 bucket for legacy path "${legacyPath}" (itemId: ${itemId}, probed tiers: ${
        getConfiguredTiers().join(", ") || "none configured"
      })`,
    );
  }

  /* -------------------------------------------------------------------
   * signFirstExisting — signs the first key that actually exists, probing
   * each candidate across all backends in tier order. Returns null when no
   * candidate exists anywhere.
   * ------------------------------------------------------------------- */

  async signFirstExisting(
    keys: string[],
    expiresIn: number,
  ): Promise<ResolvedStoragePath | null> {
    for (const key of keys) {
      try {
        return await this.probeKey(key, expiresIn);
      } catch {
        // not in any backend under this key — try the next candidate
      }
    }
    return null;
  }

  /* -------------------------------------------------------------------
   * probeKey — HEAD-probes one canonical key across every B2 backend, signing
   * on first hit. Probe order matches selectBucket() candidateChain:
   *   1. b2-quinta (B2_QUINTET)
   *   2. b2-tertiary
   *   3. b2-primary (B2)
   *   4. b2-secondary
   *   5. b2-quartet
   * NOTE: no Supabase fallback — audio is B2-only by design (Supabase storage
   * is covers/light assets only, served from the "covers" bucket outside
   * this router).
   * ------------------------------------------------------------------- */

  private async probeKey(
    key: string,
    expiresIn: number,
  ): Promise<ResolvedStoragePath> {
    const cleanKey = key.replace(/^\/+/, "");

    const b2Tiers: BucketTier[] = [
      "B2_QUINTET",
      "B2_TERTIARY",
      "B2",
      "B2_SECONDARY",
      "B2_QUARTET",
    ];

    for (const tier of b2Tiers) {
      if (isTierConfigured(tier)) {
        try {
          const client = getB2Client(tier);
          const bucketName = getConfig(tier).bucketName;
          await client.send(
            new HeadObjectCommand({
              Bucket: bucketName,
              Key: cleanKey,
            }),
          );
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: cleanKey,
          });
          // @ts-ignore
          const signedUrl = await getSignedUrl(client, command, {
            expiresIn,
          });
          return {
            signedUrl,
            canonicalPath: `${tierToPrefix(tier)}${cleanKey}`,
          };
        } catch (err: any) {
          // If B2 returned 403 (Class B cap exceeded), verify existence via Class A ListObjectsV2 probe
          if (
            err?.$metadata?.httpStatusCode === 403 ||
            err?.name === "AccessDenied"
          ) {
            try {
              const client = getB2Client(tier);
              const bucketName = getConfig(tier).bucketName;
              const listRes = await client.send(
                new ListObjectsV2Command({
                  Bucket: bucketName,
                  Prefix: cleanKey,
                  MaxKeys: 1,
                }),
              );
              if (
                listRes.Contents &&
                listRes.Contents.some((c) => c.Key === cleanKey)
              ) {
                const command = new GetObjectCommand({
                  Bucket: bucketName,
                  Key: cleanKey,
                });
                // @ts-ignore
                const signedUrl = await getSignedUrl(client, command, {
                  expiresIn,
                });
                return {
                  signedUrl,
                  canonicalPath: `${tierToPrefix(tier)}${cleanKey}`,
                };
              }
            } catch {
              // proceed to next tier
            }
          }
          // not in this tier — continue to next tier
        }
      }
    }

    throw new Error(
      `File not found in any B2 bucket for key "${cleanKey}" (probed tiers: ${
        getConfiguredTiers().join(", ") || "none configured"
      })`,
    );
  }

  /* -------------------------------------------------------------------------
   * fileExists — checks if an AUDIO file exists at the given path (B2-only).
   * supabase:// audio URIs always return false: audio never lives in
   * Supabase (covers bucket only).
   * ------------------------------------------------------------------------- */

  async fileExists(path: string): Promise<boolean> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      return false;
    }

    if (parsed.tier === "SUPABASE") {
      return false;
    }

    if (!isTierConfigured(parsed.tier)) {
      return false;
    }

    try {
      const client = getB2Client(parsed.tier);
      await client.send(
        new HeadObjectCommand({
          Bucket: getConfig(parsed.tier).bucketName,
          Key: parsed.key,
        }),
      );
      return true;
    } catch (err: any) {
      // If 403 (e.g. Backblaze B2 Class B cap exceeded), fall back to Class A ListObjectsV2 probe
      if (
        err?.$metadata?.httpStatusCode === 403 || err?.name === "AccessDenied"
      ) {
        try {
          const client = getB2Client(parsed.tier);
          const listRes = await client.send(
            new ListObjectsV2Command({
              Bucket: getConfig(parsed.tier).bucketName,
              Prefix: parsed.key,
              MaxKeys: 1,
            }),
          );
          return Boolean(
            listRes.Contents &&
              listRes.Contents.some((c) => c.Key === parsed.key),
          );
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /* -------------------------------------------------------------------------
   * deletePath — deletes an AUDIO object from its B2 tier.
   * deletePathDetailed preserves unsupported and failed states for callers
   * that need a durable cleanup result.
   * ------------------------------------------------------------------------- */

  async deletePathDetailed(
    path: string,
    itemId?: string,
  ): Promise<StorageDeleteResult> {
    let parsed = this.parsePath(path);
    if (!parsed) {
      return { status: "unsupported", error: "Unsupported storage path" };
    }
    if (parsed.tier === "SUPABASE") {
      return {
        status: "unsupported",
        error: "Supabase audio is not supported",
      };
    }
    if (parsed.isLegacy) {
      if (!itemId) {
        return {
          status: "failed",
          error: "Item id is required to resolve a legacy storage path",
        };
      }
      const legacyKey = path.replace(/^\/+/, "");
      const traversal = /(^|\/)\.\.(\/|$)/.test(legacyKey);
      const relativeKey = !legacyKey.includes("://") &&
        !legacyKey.startsWith(`${itemId}/`) &&
        !legacyKey.startsWith(`audiobooks/${itemId}/`);
      if (
        traversal || (!relativeKey && !legacyKey.startsWith(`${itemId}/`) &&
          !legacyKey.startsWith(`audiobooks/${itemId}/`))
      ) {
        return {
          status: "failed",
          error: "Legacy storage path is outside the item prefix",
        };
      }
      const ownedKey = relativeKey ? `${itemId}/${legacyKey}` : legacyKey;
      const keys = Array.from(
        new Set([
          ownedKey,
          `audiobooks/${ownedKey}`,
        ]),
      );
      let attempted = false;
      let firstError: unknown;
      for (const tier of getConfiguredTiers()) {
        for (const key of keys) {
          attempted = true;
          try {
            const client = getB2Client(tier);
            await client.send(
              new DeleteObjectCommand({
                Bucket: getConfig(tier).bucketName,
                Key: key,
              }),
            );
          } catch (error) {
            if (!isMissingObjectError(error)) firstError ??= error;
          }
        }
      }
      if (firstError) {
        return {
          status: "failed",
          error: firstError instanceof Error
            ? firstError.message
            : String(firstError),
        };
      }
      return attempted ? { status: "deleted" } : {
        status: "failed",
        error: "No B2 tier is configured for legacy storage cleanup",
      };
    }
    if (!isTierConfigured(parsed.tier)) {
      return {
        status: "failed",
        error: `Bucket tier ${parsed.tier} is not configured`,
      };
    }
    try {
      const client = getB2Client(parsed.tier);
      await client.send(
        new DeleteObjectCommand({
          Bucket: getConfig(parsed.tier).bucketName,
          Key: parsed.key,
        }),
      );
      return { status: "deleted" };
    } catch (error) {
      if (isMissingObjectError(error)) return { status: "absent" };
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deletePath(path: string, itemId?: string): Promise<boolean> {
    const result = await this.deletePathDetailed(path, itemId);
    return result.status === "deleted" || result.status === "absent";
  }
}
