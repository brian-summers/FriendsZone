/**
 * Request rate limiting.
 *
 * A token bucket per (class, key). See docs/adr/0020-rate-limiting.md for why
 * buckets rather than fixed windows, why classes rather than numbers on routes,
 * and — most importantly — the consequence of holding this in process memory.
 *
 * Deliberately *not* in `packages/policy`: the kernel is pure, may not hold
 * state or read a clock, and "how many times have you asked" is not an
 * authorization question about a resource.
 */

/**
 * The closed set of limits.
 *
 * A route names one of these rather than carrying numbers, so "what are our
 * limits" is answerable by reading this file instead of every route file.
 */
export type RateLimitClass = 'DEFAULT' | 'READ' | 'WRITE' | 'EXPENSIVE' | 'UPLOAD';

export interface BucketSpec {
  /** Maximum burst. Also the starting allowance for a key never seen before. */
  readonly capacity: number;
  /** Tokens added per second. The sustained rate. */
  readonly refillPerSecond: number;
}

/**
 * Chosen to be invisible to a person using the product and obstructive to a
 * script. All guesswork until there is production traffic to measure.
 */
export const RATE_LIMITS: Readonly<Record<RateLimitClass, BucketSpec>> = Object.freeze({
  /** Anything unremarkable. Generous: this is not the interesting control. */
  DEFAULT: { capacity: 120, refillPerSecond: 2 },

  /**
   * Calendar and listing reads. The aggregate of individually-safe reads is a
   * scraping run, which is the thing ADR 0008 leans on this to bound.
   */
  READ: { capacity: 90, refillPerSecond: 1.5 },

  /** Anything that mutates. A person cannot type this fast. */
  WRITE: { capacity: 30, refillPerSecond: 0.5 },

  /**
   * The slot finder: one call fans out to as many as twenty calendar
   * projections, so it is limited separately and much harder, exactly as
   * ADR 0008 requires.
   */
  EXPENSIVE: { capacity: 12, refillPerSecond: 0.1 },

  /** Photo upload. Each accepted call costs megabytes of storage. */
  UPLOAD: { capacity: 10, refillPerSecond: 0.05 },
});

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole seconds a refused caller should wait. At least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * The arithmetic, as a pure function.
 *
 * Separated from the store so the interesting part — refill, clamping, whether
 * a burst is permitted — is testable without a clock or a map.
 */
export function consume(bucket: Bucket, spec: BucketSpec, nowMs: number): RateLimitVerdict {
  const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);

  // Refill, clamped at capacity. Clamping is what makes this a bucket rather
  // than an allowance that accrues forever while someone is idle.
  bucket.tokens = Math.min(spec.capacity, bucket.tokens + elapsedSeconds * spec.refillPerSecond);
  bucket.lastRefillMs = nowMs;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const secondsToOneToken = (1 - bucket.tokens) / spec.refillPerSecond;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(secondsToOneToken)) };
}

/**
 * One method, on purpose.
 *
 * Process memory is the wrong home for this the moment there are two instances
 * (ADR 0020). Keeping the interface to a single call means swapping in a shared
 * counter is an adapter, not a rewrite.
 */
export interface RateLimiter {
  check(limitClass: RateLimitClass, key: string, nowMs?: number): RateLimitVerdict;
}

/** Never limits. Used by the test suite and refused in production by config. */
export const UNLIMITED: RateLimiter = {
  check: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

/**
 * Bounded so the limiter cannot become the exhaustion vector it exists to
 * prevent. Roughly a few MB of buckets at worst.
 */
const MAX_TRACKED_KEYS = 50_000;

export function createRateLimiter(
  limits: Readonly<Record<RateLimitClass, BucketSpec>> = RATE_LIMITS,
): RateLimiter {
  // Insertion-ordered, which is what makes the eviction below "oldest first".
  const buckets = new Map<string, Bucket>();

  return {
    check(limitClass, key, nowMs = Date.now()) {
      const spec = limits[limitClass];
      const composite = `${limitClass}:${key}`;

      let bucket = buckets.get(composite);
      if (bucket === undefined) {
        /**
         * Evict oldest-first when full.
         *
         * This is forgiving in the wrong direction — a flood of distinct keys
         * can evict a legitimate caller's bucket and hand them a fresh
         * allowance. The alternative, refusing service when the table is full,
         * would let anyone lock out every user by filling it. Forgiving is the
         * correct failure direction here, and only because the buckets are
         * cheap (ADR 0020).
         */
        if (buckets.size >= MAX_TRACKED_KEYS) {
          const oldest = buckets.keys().next();
          if (!oldest.done) buckets.delete(oldest.value);
        }
        bucket = { tokens: spec.capacity, lastRefillMs: nowMs };
        buckets.set(composite, bucket);
      }

      return consume(bucket, spec, nowMs);
    },
  };
}
