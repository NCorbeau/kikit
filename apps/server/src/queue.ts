import PQueue from 'p-queue';

export class OverloadError extends Error {}
export class ShutdownError extends Error {}
export interface QueueMetrics {
  admitted: number; completed: number; failures: number; rejected: number;
  pendingCount: number; pendingBytes: number; waitMs: number; processingMs: number;
}
export class PageQueues {
  private queues = new Map<string, { queue: PQueue; count: number; bytes: number }>();
  private accepting = true;
  readonly metrics: QueueMetrics = { admitted: 0, completed: 0, failures: 0, rejected: 0, pendingCount: 0, pendingBytes: 0, waitMs: 0, processingMs: 0 };
  constructor(private limits = { pageCount: 64, pageBytes: 8 * 1024 * 1024, globalCount: 256, globalBytes: 32 * 1024 * 1024 }) {}
  async run<T>(pageId: string, bytes: number, task: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new ShutdownError('Server is draining');
    let entry = this.queues.get(pageId);
    if (!entry) { entry = { queue: new PQueue({ concurrency: 1 }), count: 0, bytes: 0 }; this.queues.set(pageId, entry); }
    if (entry.count >= this.limits.pageCount || entry.bytes + bytes > this.limits.pageBytes || this.metrics.pendingCount >= this.limits.globalCount || this.metrics.pendingBytes + bytes > this.limits.globalBytes) {
      if (entry.count === 0) this.queues.delete(pageId);
      this.metrics.rejected++; throw new OverloadError('Synchronization queue is full');
    }
    entry.count++; entry.bytes += bytes;
    this.metrics.pendingCount++; this.metrics.pendingBytes += bytes; this.metrics.admitted++;
    const admittedAt = performance.now();
    try {
      return await entry.queue.add(async () => {
        const startedAt = performance.now();
        this.metrics.waitMs += startedAt - admittedAt;
        try {
          if (!this.accepting) throw new ShutdownError('Server is draining');
          const result = await task(); this.metrics.completed++; return result;
        } catch (error) { this.metrics.failures++; throw error; }
        finally { this.metrics.processingMs += performance.now() - startedAt; }
      }) as T;
    } finally {
      entry.count--; entry.bytes -= bytes;
      this.metrics.pendingCount--; this.metrics.pendingBytes -= bytes;
      if (entry.count === 0) this.queues.delete(pageId);
    }
  }
  async drain(): Promise<void> {
    this.accepting = false;
    // Queued work rejects when reached; running work retains its serialization slot
    // until its database operation completes or rolls back. No timeout races COMMIT.
    await Promise.all([...this.queues.values()].map(entry => entry.queue.onIdle()));
  }
}
