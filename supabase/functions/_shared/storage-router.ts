/* ============================================================================
 * STORAGE ROUTER — WITH SINGLE CONFIG SOURCE OF TRUTH
 *
 * PURPOSE: Routes storage paths (b2-tertiary://, b2-secondary://, b2-quartet://,
 * b2-quinta://, b2-primary://, b2://, supabase://) to the correct B2 client or
 * Supabase Storage.
 * Probing order: b2-tertiary → b2-secondary → b2-quartet → b2-quinta → b2-primary → supabase.
 *
 * KEY IMPROVEMENTS:
 *   - Config from b2-config.ts single source (not scattered env reads)
 *   - Full support for all 5 B2 tiers including B2_QUARTET and B2_QUINTET
 *   - Support for both hyphenated (b2-secondary://) and underscored (b2_secondary://) schemes
 *   - Proactive multi-candidate legacy path resolution
 *   - Real HEAD probes with health-gated fallbacks
 *   - Graceful degradation to Supabase when all B2 tiers fail
 * ========================================================================== */

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@^3.693.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@^3.693.0";

import { BucketTier } from "./b2-types.ts";
import { getConfig, isTierConfigured } from "./b2-config.ts";

// S3Client instances are cached per-process to avoid re-initialising on every
// request. Within a single invocation (e.g. signing N tracks in parallel), this
// avoids N allocations.
const _b2Clients: Map<BucketTier, S3Client> = new Map();

/* -------------------------------------------------------------------------
 * Lazy-initialised B2 clients — one per tier, created on first access.
 * ------------------------------------------------------------------------- */

function getB2Client(tier: BucketTier): S3Client {
  if (_b2Clients.has(tier)) {
    return _b2Clients.get(tier)!;
  }

  const config = getConfig(tier);

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.appKey,
    },
    forcePathStyle: true,
    // @ts-ignore
    requestChecksumCalculation: "WHEN_REQUIRED",
    // @ts-ignore
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  _b2Clients.set(tier, client);
  return client;
}

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

/* -------------------------------------------------------------------------
 * StorageRouter class — main API for all storage path operations.
 * ------------------------------------------------------------------------- */

export class StorageRouter {
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
   * getSignedUrl — returns a presigned URL for the given storage path.
   * ------------------------------------------------------------------- */

  async getSignedUrl(path: string, expiresIn: number): Promise<string> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      throw new Error(`Unsupported storage provider for path: ${path}`);
    }

    if (parsed.tier === "SUPABASE") {
      const { data, error } = await this.supabase.storage
        .from("audio-files")
        .createSignedUrl(parsed.key, expiresIn);

      if (error || !data?.signedUrl) {
        throw new Error(`Supabase presign failed: ${error?.message}`);
      }
      return data.signedUrl;
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
   * all candidate keys across all B2 backends and Supabase Storage.
   * ------------------------------------------------------------------- */

  async resolveAndSign(
    legacyPath: string,
    itemId: string,
    expiresIn: number,
  ): Promise<ResolvedStoragePath> {
    const filename = legacyPath.split("/").pop()!;
    const cleanLegacy = legacyPath.replace(/^\/+/, "");
    const candidates = [
      `${itemId}/${filename}`,
      cleanLegacy,
      `audiobooks/${cleanLegacy}`,
      cleanLegacy.replace(/^audiobooks\//, ""),
      filename,
    ].filter(Boolean);

    const uniqueCandidates = Array.from(new Set(candidates));
    const resolved = await this.signFirstExisting(uniqueCandidates, expiresIn);
    if (resolved) {
      return resolved;
    }

    throw new Error(
      `File not found in any storage backend for legacy path "${legacyPath}" (itemId: ${itemId})`,
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
   * probeKey — HEAD-probes one canonical key across every backend, signing on
   * first hit. Probe order:
   *   1. b2-tertiary
   *   2. b2-secondary
   *   3. b2-quartet
   *   4. b2-quinta
   *   5. b2-primary
   *   6. Supabase Storage
   * ------------------------------------------------------------------- */

  private async probeKey(
    key: string,
    expiresIn: number,
  ): Promise<ResolvedStoragePath> {
    const cleanKey = key.replace(/^\/+/, "");

    const b2Tiers: BucketTier[] = [
      "B2_TERTIARY",
      "B2_SECONDARY",
      "B2_QUARTET",
      "B2_QUINTET",
      "B2",
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
        } catch {
          // not in this tier — continue to next tier
        }
      }
    }

    // Try Supabase Storage — last resort
    try {
      const folder = cleanKey.split("/").slice(0, -1).join("/");
      const filename = cleanKey.split("/").pop()!;
      const { data: listed, error: listErr } = await this.supabase.storage
        .from("audio-files")
        .list(folder, { search: filename });

      if (!listErr && listed && listed.some((f: any) => f.name === filename)) {
        const { data, error } = await this.supabase.storage
          .from("audio-files")
          .createSignedUrl(cleanKey, expiresIn);

        if (!error && data?.signedUrl) {
          return {
            signedUrl: data.signedUrl,
            canonicalPath: `supabase://${cleanKey}`,
          };
        }
      }
    } catch {
      // Supabase storage check failed
    }

    throw new Error(
      `File not found in any storage backend for key "${cleanKey}"`,
    );
  }

  /* -------------------------------------------------------------------------
   * fileExists — checks if a file exists at the given path.
   * ------------------------------------------------------------------------- */

  async fileExists(path: string): Promise<boolean> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      return false;
    }

    if (parsed.tier === "SUPABASE") {
      try {
        const folder = parsed.key.split("/").slice(0, -1).join("/");
        const filename = parsed.key.split("/").pop()!;
        const { data, error } = await this.supabase.storage
          .from("audio-files")
          .list(folder, { search: filename });
        return !error && !!(data && data.some((f: any) => f.name === filename));
      } catch {
        return false;
      }
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
    } catch {
      return false;
    }
  }
}
