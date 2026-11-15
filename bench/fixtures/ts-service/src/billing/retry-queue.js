/**
 * Schedules webhook delivery retries with exponential backoff and decorrelated
 * jitter so upstream billing receivers are not flooded after outages.
 */
export class WebhookRetryQueue {
  constructor(options = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.pending = [];
  }

  computeBackoffMs(attempt, randomFn = Math.random) {
    const raw = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const jitterWindow = raw * 0.35;
    const jitter = (randomFn() * 2 - 1) * jitterWindow;
    return Math.max(this.baseDelayMs, Math.round(raw + jitter));
  }

  enqueueFailure(deliveryId, payload, attempt = 1) {
    if (attempt > this.maxAttempts) {
      return { deadLetter: true, deliveryId, attempt };
    }
    const delayMs = this.computeBackoffMs(attempt);
    const job = {
      deliveryId,
      payload,
      attempt,
      nextRunAt: Date.now() + delayMs,
    };
    this.pending.push(job);
    return job;
  }
}
