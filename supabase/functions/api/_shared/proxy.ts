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
