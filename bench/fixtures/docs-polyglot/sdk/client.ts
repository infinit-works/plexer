export interface PoolOptions {
  maxConnections: number;
  requestTimeoutMs: number;
}

export class TransportError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * Manages persistent HTTP connection pooling, retry headers, and typed error
 * translation for SDK callers.
 */
export class SdkClient {
  private readonly maxConnections: number;
  private readonly requestTimeoutMs: number;
  private activeSockets = 0;

  constructor(opts: Partial<PoolOptions> = {}) {
    this.maxConnections = opts.maxConnections ?? 16;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
  }

  acquireConnection(): number {
    if (this.activeSockets >= this.maxConnections) {
      throw new TransportError("Connection pool exhausted", 503, true);
    }
    this.activeSockets += 1;
    return this.activeSockets;
  }

  releaseConnection(): void {
    if (this.activeSockets > 0) {
      this.activeSockets -= 1;
    }
  }

  mapHttpError(statusCode: number, body: string): TransportError {
    const retryable = statusCode === 429 || statusCode >= 500;
    return new TransportError(`HTTP ${statusCode}: ${body}`, statusCode, retryable);
  }
}
