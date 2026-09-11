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
      console.warn(
        "[Sentry] SUPABASE_SECRET_KEYS parsed but no 'default' key found",
      );
    } catch (err) {
      console.error(
        "[Sentry] Failed to parse SUPABASE_SECRET_KEYS:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  console.warn("[Sentry] No service role key found in environment");
  return undefined;
}

// Read a named secret from Supabase Vault through the security-definer RPC
// created by the vault_secret_reader migration. Returns null when the runtime
// has no credentials (e.g. local Deno runs) so Sentry stays disabled instead
// of crashing.
async function readVaultSecret(name: string): Promise<string | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = resolveSecretKey();
  if (!url || !key) {
    console.warn(
      `[Sentry] Cannot read vault secret '${name}': missing SUPABASE_URL or service key`,
    );
    return null;
  }

  try {
    const supabase = createClient(url, key);
    const { data, error } = await supabase.rpc("read_secret", { p_name: name });
    if (error) {
      console.error(`[Sentry] Vault RPC error for '${name}':`, error.message);
      return null;
    }
    if (!data) {
      console.warn(`[Sentry] No vault secret found for '${name}'`);
      return null;
    }
    return (data as string) ?? null;
  } catch (err) {
    console.error(
      `[Sentry] Failed to read vault secret '${name}':`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// SENTRY_DSN: env var wins (local dev via config.toml), otherwise Vault.
let dsn: string | undefined | null = Deno.env.get("SENTRY_DSN");

if (!dsn) {
  dsn = await readVaultSecret("SENTRY_DSN");
  if (dsn) {
    console.info("[Sentry] DSN loaded from Vault");
  } else {
    console.warn(
      "[Sentry] No DSN found in environment or Vault - Sentry disabled",
    );
  }
} else {
  console.info("[Sentry] DSN loaded from environment variable");
}

if (dsn) {
  try {
    Sentry.init({
      dsn,
      environment: Deno.env.get("NODE_ENV") || "development",
      // DENO_DEPLOYMENT_ID is the deployed function version — tags events so the
      // remediation pipeline can map a crash to the exact code that threw.
      release: Deno.env.get("DENO_DEPLOYMENT_ID") || undefined,
      tracesSampleRate: Deno.env.get("NODE_ENV") === "production" ? 0.1 : 1.0,
    });
    console.info("[Sentry] Initialized successfully");
  } catch (err) {
    console.error(
      "[Sentry] Initialization failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
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
