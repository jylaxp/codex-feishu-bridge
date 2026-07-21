/**
 * Owns per-thread exclusivity and bounded FIFO handoff. It contains no task
 * payload semantics and never persists queue entries.
 */
export class ThreadTaskScheduler<TTask, TQueued> {
  private readonly activeByThreadId = new Map<string, TTask>();
  private readonly queuesByThreadId = new Map<string, TQueued[]>();

  public active(threadId: string): TTask | undefined {
    return this.activeByThreadId.get(threadId);
  }

  public hasActive(threadId: string): boolean {
    return this.activeByThreadId.has(threadId);
  }

  public activeThreadIds(): readonly string[] {
    return Object.freeze([...this.activeByThreadId.keys()]);
  }

  public get activeCount(): number {
    return this.activeByThreadId.size;
  }

  public get queuedCount(): number {
    let count = 0;
    for (const queue of this.queuesByThreadId.values()) {
      count += queue.length;
    }
    return count;
  }

  public activate(threadId: string, task: TTask): void {
    const active = this.activeByThreadId.get(threadId);
    if (active !== undefined && active !== task) {
      throw new Error('Thread already has an active task');
    }
    this.activeByThreadId.set(threadId, task);
  }

  public release(threadId: string, task: TTask): boolean {
    if (this.activeByThreadId.get(threadId) !== task) {
      return false;
    }
    this.activeByThreadId.delete(threadId);
    return true;
  }

  public enqueue(threadId: string, item: TQueued, maximumQueued: number): boolean {
    const queue = this.queuesByThreadId.get(threadId) ?? [];
    if (queue.length >= maximumQueued) {
      return false;
    }
    queue.push(item);
    this.queuesByThreadId.set(threadId, queue);
    return true;
  }

  public takeNext(threadId: string): TQueued | undefined {
    const queue = this.queuesByThreadId.get(threadId);
    const next = queue?.shift();
    if (queue?.length === 0) {
      this.queuesByThreadId.delete(threadId);
    }
    return next;
  }

  public drainQueued(): readonly TQueued[] {
    const queued = [...this.queuesByThreadId.values()].flat();
    this.queuesByThreadId.clear();
    return queued;
  }

  public clear(): boolean {
    const hadActive = this.activeByThreadId.size > 0;
    this.activeByThreadId.clear();
    this.queuesByThreadId.clear();
    return hadActive;
  }
}
