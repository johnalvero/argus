/**
 * Per-token leaky-bucket rate limit for `/api/v1/reports`.
 *
 * Keyed on `IngestToken.id` (not raw token, not IP) — a single
 * misbehaving agent gets throttled without affecting siblings sharing
 * the same egress NAT. The token has already been verified by the time
 * we get here, so the lookup is trusted.
 *
 * Bucket policy: 60 requests / 60 s window, fixed window. The window
 * is short enough that legitimate agents (one ping per ~15 min) never
 * trip it, but a host stuck in a re-exec loop hits the cap within
 * seconds and stops hammering the DB.
 *
 * In-process map — Argus is a single-node service. Multi-node would
 * need Redis, but that's a Day-N concern.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const SWEEP_THRESHOLD = 5000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<number, Bucket>();

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function checkIngestRateLimit(tokenId: number): RateLimitDecision {
  const now = Date.now();
  const existing = buckets.get(tokenId);

  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(tokenId, fresh);
    maybeSweep(now);
    return {
      allowed: true,
      remaining: MAX_PER_WINDOW - 1,
      resetAt: fresh.resetAt,
    };
  }

  if (existing.count >= MAX_PER_WINDOW) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: MAX_PER_WINDOW - existing.count,
    resetAt: existing.resetAt,
  };
}

function maybeSweep(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [id, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(id);
  }
}
