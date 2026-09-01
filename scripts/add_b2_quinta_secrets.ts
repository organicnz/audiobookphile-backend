import { createClient } from "npm:@supabase/supabase-js@2.44.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

async function addToVault(secretKey: string, secretValue: string) {
  try {
    const { error } = await supabase.from("secrets").insert({
      key: secretKey,
      value: secretValue,
    });
    console.log(`Vault ${secretKey}:`, error?.message || "success");
    return error?.message || "success";
  } catch (e: any) {
    console.error(`Vault ${secretKey}:`, e.message);
    return e.message;
  }
}

async function main() {
  console.log("Adding B2 Quinta secrets to Supabase Vault...\n");

  const secrets: [string, string][] = [
    ["B2_QUINTA_KEY_ID", Deno.env.get("B2_QUINTA_KEY_ID")!],
    ["B2_QUINTA_APP_KEY", Deno.env.get("B2_QUINTA_APP_KEY")!],
    ["B2_QUINTA_BUCKET_NAME", Deno.env.get("B2_QUINTA_BUCKET_NAME")!],
    ["B2_QUINTA_ENDPOINT", Deno.env.get("B2_QUINTA_ENDPOINT")!],
    ["B2_QUINTA_REGION", Deno.env.get("B2_QUINTA_REGION") || "us-west-004"],
  ];

  for (const [key, value] of secrets) {
    if (!value) {
      console.log(`  Skipping ${key}: env var not set`);
      continue;
    }
    const result = await addToVault(key, value);
    console.log(`  ${key}: ${result}`);
  }

  console.log("\nDone! Secrets added to Supabase Vault.");
}

main();
