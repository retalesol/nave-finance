// Lightweight best-effort rate limiter for Supabase edge functions.
//
// Edge functions are ephemeral, so this is a per-warm-instance token bucket
// keyed by a caller identifier (IP or secret hash). It throttles bursts and
// abuse on a single instance; for strict global limits back it with a shared
// store (Upstash/Postgres). It is deliberately dependency-free.
//
// Usage:
//   const limited = rateLimit(req, { key: clientKey(req), limit: 30, windowMs: 60_000 }, corsHeaders);
//   if (limited) return limited; // 429 Response

import { jsonWithCors } from "./http.ts";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Derive a caller key: prefer a forwarded IP, fall back to a header secret. */
export function clientKey(req: Request, extra = ""): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";
  return `${ip}:${extra}`;
}

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * Returns a ready-to-return 429 Response when the caller exceeds the limit, or
 * null when the request is allowed.
 */
export function rateLimit(
  _req: Request,
  opts: RateLimitOptions,
  corsHeaders: Record<string, string>,
): Response | null {
  const now = Date.now();
  const bucket = buckets.get(opts.key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(opts.key, { count: 1, resetAt: now + opts.windowMs });
    return null;
  }

  if (bucket.count >= opts.limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return jsonWithCors(
      { ...corsHeaders, "Retry-After": String(retryAfter) },
      { error: "Too many requests", retry_after_seconds: retryAfter },
      429,
    );
  }

  bucket.count += 1;
  // Opportunistic cleanup so the map does not grow unbounded on a warm instance.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now >= v.resetAt) buckets.delete(k);
    }
  }
  return null;
}
