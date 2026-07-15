/**
 * Shares the account rate-limit read across task cards and `/usage` without
 * persisting quota data. Failed reads deliberately do not poison the cache.
 */
export class RateLimitCache {
  private cached: unknown;
  private expiresAtMs = 0;
  private inFlight: Promise<unknown> | undefined;

  public constructor(
    private readonly read: () => Promise<unknown>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError('rate-limit cache ttl must be a positive safe integer');
    }
  }

  public get(): Promise<unknown> {
    if (this.cached !== undefined && this.now() < this.expiresAtMs) {
      return Promise.resolve(this.cached);
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const request = this.read();
    this.inFlight = request;
    return request.then((response) => {
      this.cached = response;
      this.expiresAtMs = this.now() + this.ttlMs;
      return response;
    }).finally(() => {
      if (this.inFlight === request) {
        this.inFlight = undefined;
      }
    });
  }
}
