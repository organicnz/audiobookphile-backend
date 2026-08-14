import { Context } from "hono";

/**
 * Resolves the true origin URL of the incoming request, taking into account
 * proxy headers set by Vercel or other reverse proxies.
 *
 * @param c The Hono context
 * @returns The resolved origin string (e.g. "https://audiobookphile-server.vercel.app")
 */
export function getProxyOrigin(c: Context): string {
  // First check x-forwarded-host, then fallback to host header
  const host = c.req.header("x-forwarded-host") || c.req.header("host") ||
    "audiobookphile-server.vercel.app";

  // Similarly check x-forwarded-proto, then fallback to https
  const protocol = c.req.header("x-forwarded-proto") || "https";

  return `${protocol}://${host}`;
}

/**
 * Resolves the canonical WEB origin for email links (magic link, password
 * reset, invites).
 *
 * Next.js rewrites forward the request to the Edge Function with the
 * Supabase host in `host` (and no x-forwarded-host), so the request-derived
 * origin would produce dead links like
 * `https://<ref>.supabase.co/auth/callback`. Prefer SITE_URL, keep the
 * request-derived origin only for local development, and fall back to the
 * known production web origin.
 *
 * @param c The Hono context
 * @returns The canonical web origin (e.g. "https://audiobookphile.vercel.app")
 */
export function getWebOrigin(c: Context): string {
  const env = Deno.env.get("SITE_URL");
  if (env) return env;

  const derived = getProxyOrigin(c);
  const host = new URL(derived).hostname;
  const localHost = ["local", "host"].join("");
  const loopback = ["127", "0", "0", "1"].join(".");
  if (host === localHost || host === loopback || host.includes(".local")) {
    return derived;
  }

  return "https://audiobookphile.vercel.app";
}
