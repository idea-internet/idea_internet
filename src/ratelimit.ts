// Fixed-window rate limiter backed by KV.
// KV is eventually consistent, so counts are approximate — good enough to
// stop brute-force and abuse, not a hard guarantee.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  bucket: string,
  id: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const key = `rl:${bucket}:${id}`;
  const now = Date.now();
  const raw = (await kv.get(key, "json")) as { count: number; reset: number } | null;

  // Cloudflare KV requires expirationTtl >= 60s. Anything smaller throws a 400
  // that would otherwise escape as a 500. The window is approximate anyway, so
  // clamping the TTL up is harmless (stale keys just linger a few seconds).
  const ttlFor = (seconds: number) => Math.max(60, Math.ceil(seconds) + 5);
  // Best-effort write: a KV put failure must never break the request, so the
  // limiter fails OPEN rather than throwing.
  const safePut = (value: unknown, ttl: number) => kv.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {});

  if (!raw || now >= raw.reset) {
    const reset = now + windowMs;
    await safePut({ count: 1, reset }, ttlFor(windowMs / 1000));
    return { allowed: true, remaining: limit - 1, resetAt: reset };
  }

  if (raw.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: raw.reset };
  }

  await safePut({ count: raw.count + 1, reset: raw.reset }, ttlFor((raw.reset - now) / 1000));
  return { allowed: true, remaining: limit - raw.count - 1, resetAt: raw.reset };
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.remaining >= 0 ? result.remaining + 1 : 0),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
}

// Policy constants (per window)
export const RATE_LIMITS = {
  register: { limit: 5, windowMs: 3600_000 },   // 5/hour per IP
  login: { limit: 20, windowMs: 3600_000 },     // 20/hour per IP
  deploy: { limit: 60, windowMs: 3600_000 },    // 60/hour per user
  upload: { limit: 60, windowMs: 3600_000 },    // 60/hour per user
  db: { limit: 120, windowMs: 60_000 },         // 120/min per site token (public data API)
} as const;
