import * as Sentry from "@sentry/deno";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";

// Resolve the service-role credential from the Edge Runtime, preferring the new
// SUPABASE_SECRET_KEYS JSON and falling back to the legacy injected key.
function resolveSecretKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      // malformed JSON — fall through to vault-less init below
    }
  }
  return undefined;
}

// Read a named secret from Supabase Vault through the security-definer RPC
// created by the vault_secret_reader migration. Returns null when the runtime
// has no credentials (e.g. local Deno runs) so Sentry stays disabled instead
// of crashing.
async function readVaultSecret(name: string): Promise<string | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = resolveSecretKey();
  if (!url || !key) return null;
  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("read_secret", { p_name: name });
  if (error) throw error;
  return (data as string | null) ?? null;
}

// SENTRY_DSN: env var wins (local dev via config.toml), otherwise Vault.
const dsn = Deno.env.get("SENTRY_DSN") ??
  await readVaultSecret("SENTRY_DSN").catch(() => null);

if (dsn) {
  Sentry.init({
    dsn,
    environment: Deno.env.get("NODE_ENV") || "development",
    tracesSampleRate: 1.0,
  });
}

export { Sentry };
