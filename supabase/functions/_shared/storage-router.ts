import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";

import { Database } from "../../../src/types/supabase.ts";

// S3Client instances are cached per-process to avoid re-initialising on every
// request. Each edge function invocation is a new process, but within a single
// invocation (e.g. signing N tracks in parallel) this avoids N allocations.
let _b2PrimaryClient: S3Client | null = null;
let _b2SecondaryClient: S3Client | null = null;

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

export class StorageRouter {
  constructor(private supabase: SupabaseClient<Database>) {}

  async getSignedUrl(path: string, expiresIn: number): Promise<string> {
    if (path.startsWith("supabase://")) {
      const actualPath = path.replace("supabase://", "");
      const { data, error } = await this.supabase.storage
        .from("audio-files")
        .createSignedUrl(actualPath, expiresIn);

      if (error || !data?.signedUrl) {
        throw new Error(`Supabase presign failed: ${error?.message}`);
      }
      return data.signedUrl;
    }

    if (path.startsWith("b2-secondary://")) {
      const actualPath = path.replace("b2-secondary://", "");
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_SECONDARY_BUCKET_NAME")!,
        Key: actualPath,
      });
      return await getSignedUrl(getB2SecondaryClient(), command, { expiresIn });
    }

    if (path.startsWith("b2://") || !path.includes("://")) {
      const actualPath = path.replace("b2://", "");
      const command = new GetObjectCommand({
        Bucket: Deno.env.get("B2_BUCKET_NAME")!,
        Key: actualPath,
      });
      return await getSignedUrl(getB2PrimaryClient(), command, { expiresIn });
    }

    throw new Error(`Unsupported storage provider for path: ${path}`);
  }

  async fileExists(path: string): Promise<boolean> {
    if (path.startsWith("supabase://")) {
      const actualPath = path.replace("supabase://", "");
      const folder = actualPath.split("/").slice(0, -1).join("/");
      const filename = actualPath.split("/").pop()!;
      const { data } = await this.supabase.storage
        .from("audio-files")
        .list(folder, { search: filename });
      return !!(data && data.length > 0 && data[0].name === filename);
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

    if (path.startsWith("b2://") || !path.includes("://")) {
      const actualPath = path.replace("b2://", "");
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
