import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
const client = new S3Client({
  endpoint: Deno.env.get("B2_ENDPOINT")!,
  region: Deno.env.get("B2_REGION") || "us-west-004",
  credentials: {
    accessKeyId: Deno.env.get("B2_KEY_ID")!,
    secretAccessKey: Deno.env.get("B2_APP_KEY")!,
  },
  forcePathStyle: true,
  // @ts-ignore — B2 does not support AWS checksum headers
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
const cmd = new HeadObjectCommand({
  Bucket: Deno.env.get("B2_BUCKET_NAME")!,
  Key: "test-key",
});
try {
  const res = await client.send(cmd);
  console.log("Success, ContentLength:", res.ContentLength);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof Error ? e.name : "UnknownError";
  console.error("Error:", msg);
  console.error("Code:", code);
}
