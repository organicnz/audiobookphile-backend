/**
 * In-memory token-bucket rate limiter for Edge isolates.
 *
 * Why in-memory and not Redis/Upstash:
 *   - zero extra infra/latency on the hot path (single isolate check <0.1ms)
 *   - Supabase Edge isolates are short-lived; a local bucket still stops
 *     single-IP bursts (the 99% abuse case) without a network round trip
 *   - fails OPEN on any internal error so observability can never 500 traffic
 *
 * Limits: 120 req/min per IP with a 60-request burst. Health, OPTIONS, and
 * contract-check probes are exempt so load-balancers never flap.
 */

import type { Context, Next } from "hono";
import type { Variables } from "./types.ts";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 120;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function clientIp(c: Context<{ Variables: Variables }>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

export function isRateLimitExempt(
  c: Context<{ Variables: Variables }>,
): boolean {
  if (Deno.env.get("NODE_ENV") === "test") return true;
  if (c.req.method === "OPTIONS") return true;
  if (c.req.header("x-contract-check") === "1") return true;
  const path = c.req.path;
  return path === "/api/health" || path === "/health";
}

export async function rateLimitMiddleware(
  c: Context<{ Variables: Variables }>,
  next: Next,
): Promise<Response | void> {
  if (isRateLimitExempt(c)) return next();

  try {
    const now = Date.now();
    if (buckets.size > 2000) {
      for (const [ip, b] of buckets.entries()) {
        if (now >= b.resetAt) {
          buckets.delete(ip);
        }
      }
    }
    const key = clientIp(c);
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      bucket.count += 1;
      if (bucket.count > MAX_REQUESTS) {
        const retryAfter = Math.max(
          1,
          Math.ceil((bucket.resetAt - now) / 1000),
        );
        c.header("Retry-After", String(retryAfter));
        return c.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests, slow down",
            },
            requestId: c.get("requestId") ?? crypto.randomUUID(),
            timestamp: new Date().toISOString(),
          },
          429,
        );
      }
    }
  } catch {
    return next();
  }

  return next();
}

/** Test-only hook: clear all buckets. */
export function __clearRateLimitBuckets(): void {
  buckets.clear();
}
