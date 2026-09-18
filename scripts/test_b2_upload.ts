import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
try {
  const testFilePath = Deno.env.get("TEST_AUDIO_FILE") ||
    new URL("../test-upload.mp3", import.meta.url).pathname;
  const file = await Deno.readFile(testFilePath);
  await client.send(
    new PutObjectCommand({
      Bucket: Deno.env.get("B2_BUCKET_NAME")!,
      Key: "test-upload.mp3",
      Body: file,
      ContentType: "audio/mpeg",
    }),
  );
  console.log("Upload succeeded");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof Error ? e.name : "UnknownError";
  console.error("Error:", msg, code);
}
