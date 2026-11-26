import { NextRequest, NextResponse } from 'next/server';
import { getSetting } from './settings';
import { trustedClientIp } from './login-security';

export interface PublicRateLimits {
  bookings_per_ip_10m: number;
  bookings_per_phone_10m: number;
  plans_per_ip_10m: number;
  autocomplete_per_ip_10m: number;
}

const DEFAULT_LIMITS: PublicRateLimits = {
  bookings_per_ip_10m: 10,
  bookings_per_phone_10m: 5,
  plans_per_ip_10m: 60,
  autocomplete_per_ip_10m: 120,
};

const WINDOW_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastPruneAt = 0;

function pruneExpired(now: number): void {
  if (now - lastPruneAt < 60_000 && buckets.size < MAX_BUCKETS) return;
  lastPruneAt = now;
  for (const [k, b] of buckets.entries()) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  // Safety cap against memory exhaustion under DDoS with spoofed keys
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let removed = 0;
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (++removed >= excess) break;
    }
  }
}

export async function getPublicRateLimits(): Promise<PublicRateLimits> {
  const raw = await getSetting<Partial<PublicRateLimits>>('public_rate_limits', {});
  const pick = (val: unknown, fallback: number) => {
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
  };
  return {
    bookings_per_ip_10m: pick(raw?.bookings_per_ip_10m, DEFAULT_LIMITS.bookings_per_ip_10m),
    bookings_per_phone_10m: pick(raw?.bookings_per_phone_10m, DEFAULT_LIMITS.bookings_per_phone_10m),
    plans_per_ip_10m: pick(raw?.plans_per_ip_10m, DEFAULT_LIMITS.plans_per_ip_10m),
    autocomplete_per_ip_10m: pick(raw?.autocomplete_per_ip_10m, DEFAULT_LIMITS.autocomplete_per_ip_10m),
  };
}

export function getPublicClientIp(req: NextRequest): string {
  return (
    trustedClientIp(req) ||
    req.headers.get('x-real-ip')?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export function consumeRateLimit(key: string, limit: number, windowMs = WINDOW_MS): RateLimitResult {
  const now = Date.now();
  pruneExpired(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, limit, remaining: Math.max(0, limit - 1), retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

export function rateLimitExceededResponse(
  result: RateLimitResult,
  message = 'Too many requests. Please try again shortly.',
  extraBody?: Record<string, unknown>
): NextResponse {
  return NextResponse.json(
    { success: false, error: message, ...extraBody },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSeconds),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
      },
    }
  );
}

/** Exposed for unit tests only. */
export function _resetRateLimitBucketsForTest(): void {
  buckets.clear();
}
