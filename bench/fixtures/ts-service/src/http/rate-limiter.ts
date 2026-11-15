import { extractBearerToken, TokenVerifier } from "../auth/token-verifier.ts";

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-tenant request throttling enforced via a sliding window token bucket.
 */
export class TenantRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(capacity = 60, refillPerSecond = 10) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
  }

  consume(tenantKey: string, cost = 1, nowMs = Date.now()): boolean {
    const state = this.buckets.get(tenantKey) ?? {
      tokens: this.capacity,
      lastRefillMs: nowMs,
    };
    const elapsedSec = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
    state.tokens = Math.min(this.capacity, state.tokens + elapsedSec * this.refillPerSecond);
    state.lastRefillMs = nowMs;

    if (state.tokens < cost) {
      this.buckets.set(tenantKey, state);
      return false;
    }
    state.tokens -= cost;
    this.buckets.set(tenantKey, state);
    return true;
  }

  async authorizeAndThrottle(verifier: TokenVerifier, authHeader: string | undefined): Promise<string> {
    const raw = extractBearerToken(authHeader);
    const claims = await verifier.verify(raw);
    if (!this.consume(claims.tenantId)) {
      throw new Error(`Tenant ${claims.tenantId} throttled`);
    }
    return claims.tenantId;
  }
}
