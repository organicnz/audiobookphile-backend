import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@^3.693.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@^3.693.0";

// S3Client instances are cached per-process to avoid re-initialising on every
// request. Each edge function invocation is a new process, but within a single
// invocation (e.g. signing N tracks in parallel) this avoids N allocations.
let _b2PrimaryClient: S3Client | null = null;
let _b2SecondaryClient: S3Client | null = null;
let _b2TertiaryClient: S3Client | null = null;

function getB2PrimaryClient(): S3Client {
  if (!_b2PrimaryClient) {
    _b2PrimaryClient = new S3Client({
      endpoint: Deno.env.get("B2_ENDPOINT")!,
      region: Deno.env.get("B2_REGION") || "us-west-004",
      credentials: {
        accessKeyId: Deno.env.get("B2_KEY_ID")!,
        secretAccessKey: Deno.env.get("B2_APP_KEY")!,
      },
      forcePathStyle: true,
      // B2 rejects presigned URLs that carry unsigned x-amz-checksum-* query
      // params, which the AWS SDK injects by default on newer versions. These
      // options force checksums to be computed only when the operation requires
      // them, keeping GetObject presigned URLs clean. Without this, every
      // download signed via this router fails with SignatureDoesNotMatch.
      // @ts-ignore — options recognised at runtime, not in older type defs
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2PrimaryClient;
}

function getB2SecondaryClient(): S3Client {
  if (!_b2SecondaryClient) {
    _b2SecondaryClient = new S3Client({
      endpoint: Deno.env.get("B2_SECONDARY_ENDPOINT")!,
      region: Deno.env.get("B2_SECONDARY_REGION") || "us-west-004",
      credentials: {
        accessKeyId: Deno.env.get("B2_SECONDARY_KEY_ID")!,
        secretAccessKey: Deno.env.get("B2_SECONDARY_APP_KEY")!,
      },
      forcePathStyle: true,
      // See getB2PrimaryClient: required to keep GetObject presigned URLs
      // B2-compatible on AWS SDK v3.693.0+ / v3.1085.0+.
      // @ts-ignore — options recognised at runtime, not in older type defs
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2SecondaryClient;
}

function getB2TertiaryClient(): S3Client {
  if (!_b2TertiaryClient) {
    _b2TertiaryClient = new S3Client({
      endpoint: Deno.env.get("B2_TERTIARY_ENDPOINT")!,
      region: Deno.env.get("B2_TERTIARY_REGION") || "us-west-004",
      credentials: {
        accessKeyId: Deno.env.get("B2_TERTIARY_KEY_ID")!,
        secretAccessKey: Deno.env.get("B2_TERTIARY_APP_KEY")!,
      },
      forcePathStyle: true,
      // See getB2PrimaryClient: required to keep GetObject presigned URLs
      // B2-compatible on AWS SDK v3.693.0+ / v3.1085.0+.
      // @ts-ignore — options recognised at runtime, not in older type defs
      requestChecksumCalculation: "WHEN_REQUIRED",
      // @ts-ignore
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _b2TertiaryClient;
}

/** True when the tertiary B2 tier is fully configured (endpoint + bucket). */
export function b2TertiaryConfigured(): boolean {
  return !!Deno.env.get("B2_TERTIARY_ENDPOINT") &&
    !!Deno.env.get("B2_TERTIARY_BUCKET_NAME");
}

/**
 * Result of a successful path resolution for a legacy bare path.
 * Contains the signed URL and the canonical storage path (with scheme prefix)
 * so callers can optionally persist the resolved path back to the DB.
 */
export interface ResolvedStoragePath {
  signedUrl: string;
  /** The canonical path with scheme prefix, e.g. "b2-secondary://itemId/file.mp3" */
  canonicalPath: string;
}

export class StorageRouter {
  constructor(private supabase: any) {}

  async getSignedUrl(path: string, expiresIn: number): Promise<string> {
    if (path.startsWith("supabase://")) {
      const actualPath = path.replace("supabase://", "");
      const { data, error } = await this.supabase.storage.from("audio-files")
        .createSignedUrl(actualPath, expiresIn);

      if (error || !data?.signedUrl) {
        throw new Error(`Supabase presign failed: ${error?.message}`);
      }
      return data.signedUrl;
    }

    if (path.startsWith("b2-tertiary://")) {
      const actualPath = path.replace("b2-tertiary://", "");
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_TERTIARY_BUCKET_NAME")!,
        Key: actualPath,
      });
      // @ts-ignore: Deno npm specifier duplication causes S3Client type mismatch
      return await getSignedUrl(getB2TertiaryClient(), command, { expiresIn });
    }

    if (path.startsWith("b2-secondary://")) {
      const actualPath = path.replace("b2-secondary://", "");
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
        Key: actualPath,
      });
      // @ts-ignore: Deno npm specifier duplication causes S3Client type mismatch
      return await getSignedUrl(getB2SecondaryClient(), command, { expiresIn });
    }

    if (
      path.startsWith("b2://") || path.startsWith("b2-primary://") ||
      path.startsWith("s3://") || !path.includes("://")
    ) {
      const actualPath = path.replace("b2://", "").replace("b2-primary://", "")
        .replace("s3://", "");
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_BUCKET_NAME")!,
        Key: actualPath,
      });
      // @ts-ignore: Deno npm specifier duplication causes S3Client type mismatch
      return await getSignedUrl(getB2PrimaryClient(), command, { expiresIn });
    }

    throw new Error(`Unsupported storage provider for path: ${path}`);
  }

  /**
   * Resolves a legacy bare filesystem path (e.g. "/audiobooks/Title/file.mp3")
   * by probing all three storage backends under the canonical key pattern:
   *   {itemId}/{filename}
   *
   * Probe order: b2-tertiary → b2-secondary → b2-primary → supabase
   * (most new uploads go to b2-tertiary, so check that first)
   *
   * Returns the signed URL and canonical path of whichever backend has the file,
   * or throws if none of them do.
   */
  async resolveAndSign(
    legacyPath: string,
    itemId: string,
    expiresIn: number,
  ): Promise<ResolvedStoragePath> {
    // Extract just the filename from the legacy path
    const filename = legacyPath.split("/").pop()!;
    return await this.probeKey(`${itemId}/${filename}`, expiresIn);
  }

  /**
   * Signs the first key that actually exists, probing each candidate across
   * all backends in tier order. Returns null when no candidate exists anywhere.
   *
   * Used by playback self-heal: presigned URLs for recorded paths are minted
   * without contacting storage, so a stale/mis-recorded path produces a URL
   * that 404s at fetch time (the "black screen" book failure mode). When the
   * recorded path is dead, the file often lives under a sibling prefix
   * (client upload bookId ≠ library item id) or in a different tier.
   */
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

  /** HEAD-probes one canonical key across every backend, signing on first hit. */
  private async probeKey(
    key: string,
    expiresIn: number,
  ): Promise<ResolvedStoragePath> {
    // 1. Try b2-tertiary (only when configured; unset envs must not throw)
    if (b2TertiaryConfigured()) {
      try {
        await getB2TertiaryClient().send(
          new HeadObjectCommand({
            Bucket: Deno.env.get("B2_TERTIARY_BUCKET_NAME")!,
            Key: key,
          }),
        );
        const command = new GetObjectCommand({
          Bucket: Deno.env.get("B2_TERTIARY_BUCKET_NAME")!,
          Key: key,
        });
        // @ts-ignore: Deno npm specifier duplication causes S3Client type mismatch
        const signedUrl = await getSignedUrl(getB2TertiaryClient(), command, {
          expiresIn,
        });
        return { signedUrl, canonicalPath: `b2-tertiary://${key}` };
      } catch {
        // not in b2-tertiary
      }
    }

    // 2. Try b2-secondary
    try {
      await getB2SecondaryClient().send(
        new HeadObjectCommand({
          Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
          Key: key,
        }),
      );
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
        Key: key,
      });
      // @ts-ignore: Deno npm specifier duplication causes S3Client type mismatch
      const signedUrl = await getSignedUrl(getB2SecondaryClient(), command, {
        expiresIn,
      });
      return { signedUrl, canonicalPath: `b2-secondary://${key}` };
    } catch {
      // not in b2-secondary
    }

    // 3. Try b2-primary
    try {
      await getB2PrimaryClient().send(
        new HeadObjectCommand({
          Bucket: Deno.env.get("B2_BUCKET_NAME")!,
          Key: key,
        }),
      );
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_BUCKET_NAME")!,
        Key: key,
      });
      // @ts-ignore: Deno npm specifier duplication causes S3Client type mismatch
      const signedUrl = await getSignedUrl(getB2PrimaryClient(), command, {
        expiresIn,
      });
      return { signedUrl, canonicalPath: `b2://${key}` };
    } catch {
      // not in b2-primary
    }

    // 4. Try Supabase Storage
    const folder = key.split("/").slice(0, -1).join("/");
    const filename = key.split("/").pop()!;
    const { data: listed } = await this.supabase.storage
      .from("audio-files")
      .list(folder, { search: filename });

    if (listed && listed.some((f: any) => f.name === filename)) {
      const supabasePath = key;
      const { data, error } = await this.supabase.storage
        .from("audio-files")
        .createSignedUrl(supabasePath, expiresIn);

      if (!error && data?.signedUrl) {
        return {
          signedUrl: data.signedUrl,
          canonicalPath: `supabase://${supabasePath}`,
        };
      }
    }

    throw new Error(
      `File not found in any storage backend for key "${key}"`,
    );
  }

  async fileExists(path: string): Promise<boolean> {
    if (path.startsWith("supabase://")) {
      const actualPath = path.replace("supabase://", "");
      const folder = actualPath.split("/").slice(0, -1).join("/");
      const filename = actualPath.split("/").pop()!;
      const { data } = await this.supabase.storage.from("audio-files").list(
        folder,
        { search: filename },
      );
      return !!(data && data.length > 0 && data[0].name === filename);
    }

    if (path.startsWith("b2-tertiary://")) {
      const actualPath = path.replace("b2-tertiary://", "");
      try {
        await getB2TertiaryClient().send(
          new HeadObjectCommand({
            Bucket: Deno.env.get("B2_TERTIARY_BUCKET_NAME")!,
            Key: actualPath,
          }),
        );
        return true;
      } catch {
        return false;
      }
    }

    if (path.startsWith("b2-secondary://")) {
      const actualPath = path.replace("b2-secondary://", "");
      try {
        await getB2SecondaryClient().send(
          new HeadObjectCommand({
            Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
            Key: actualPath,
          }),
        );
        return true;
      } catch {
        return false;
      }
    }

    if (
      path.startsWith("b2://") || path.startsWith("b2-primary://") ||
      path.startsWith("s3://") || !path.includes("://")
    ) {
      const actualPath = path.replace("b2://", "").replace("b2-primary://", "")
        .replace("s3://", "");
      try {
        await getB2PrimaryClient().send(
          new HeadObjectCommand({
            Bucket: Deno.env.get("B2_BUCKET_NAME")!,
            Key: actualPath,
          }),
        );
        return true;
      } catch {
        return false;
      }
    }

    throw new Error(`Unsupported storage provider for path: ${path}`);
  }
}
