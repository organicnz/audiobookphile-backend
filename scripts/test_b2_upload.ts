import { PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@^3.693.0";
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
  const file = await Deno.readFile(
    "/Users/organic/dev/work/audiobookphile/audiobookphile-backend/src/Arguably Essays by Christopher Hitchens/Eugenia Cheng - The Art of Logic in an Illogical World/Art of Logic 01.mp3",
  );
  await client.send(
    new PutObjectCommand({
      Bucket: Deno.env.get("B2_BUCKET_NAME")!,
      Key: "test-upload.mp3",
      Body: file,
      ContentType: "audio/mpeg",
    }),
  );
  console.log("Upload succeeded");
} catch (e: any) {
  console.error("Error:", e.message, e.name);
}
