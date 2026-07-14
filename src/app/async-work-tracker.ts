export class AsyncWorkTrackerClosedError extends Error {
  public constructor() {
    super('Async work tracker is closed');
    this.name = 'AsyncWorkTrackerClosedError';
  }
}

export class AsyncWorkTrackerCapacityError extends Error {
  public constructor() {
    super('Async work tracker is at capacity');
    this.name = 'AsyncWorkTrackerCapacityError';
  }
}

/** Tracks accepted asynchronous handlers so shutdown can drain them safely. */
export class AsyncWorkTracker {
  private readonly active = new Set<Promise<unknown>>();
  private accepting = true;

  public constructor(private readonly maxConcurrent = Number.POSITIVE_INFINITY) {
    if (maxConcurrent !== Number.POSITIVE_INFINITY
      && (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)) {
      throw new RangeError('Async work concurrency must be a positive safe integer');
    }
  }

  public track<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (!this.accepting) {
      return Promise.reject(new AsyncWorkTrackerClosedError());
    }
    if (this.active.size >= this.maxConcurrent) {
      return Promise.reject(new AsyncWorkTrackerCapacityError());
    }
    let tracked: Promise<TResult>;
    try {
      tracked = Promise.resolve(operation());
    } catch (error) {
      tracked = Promise.reject(error);
    }
    this.active.add(tracked);
    void tracked.finally(() => {
      this.active.delete(tracked);
    }).catch(() => undefined);
    return tracked;
  }

  /** Prevents any later handler from entering the tracked shutdown boundary. */
  public close(): void {
    this.accepting = false;
  }

  /** Waits until every handler accepted before close has settled. */
  public async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
}
