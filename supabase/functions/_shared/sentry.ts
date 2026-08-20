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
    // DENO_DEPLOYMENT_ID is the deployed function version — tags events so the
    // remediation pipeline can map a crash to the exact code that threw.
    release: Deno.env.get("DENO_DEPLOYMENT_ID") || undefined,
    tracesSampleRate: 1.0,
  });
}

/**
 * Per-request API metrics. Safe by construction: no-ops when the SDK is not
 * initialized and swallows any SDK error so observability can never break the
 * request path.
 */
export function trackRequestMetrics(
  method: string,
  status: number,
  durationMs: number,
): void {
  if (!Sentry.getClient()) return;
  try {
    Sentry.metrics.increment("api_requests_total", 1, {
      tags: { method, status: status.toString() },
    });
    Sentry.metrics.distribution("api_request_duration", durationMs, {
      unit: "millisecond",
      tags: { method },
    });
  } catch (err) {
    console.warn(
      "[Sentry] metrics error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export { Sentry };
