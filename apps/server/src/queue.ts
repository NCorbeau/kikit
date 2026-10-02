import PQueue from 'p-queue';

export class OverloadError extends Error {}
export class ShutdownError extends Error {}

export interface QueueMetrics {
  admitted: number;
  completed: number;
  failures: number;
  rejected: number;
  pendingCount: number;
  pendingBytes: number;
  waitMs: number;
  processingMs: number;
}
interface QueueLimits {
  pageCount: number;
  pageBytes: number;
  globalCount: number;
  globalBytes: number;
}
interface PageQueue {
  queue: PQueue;
  count: number;
  bytes: number;
}
const DEFAULT_LIMITS: QueueLimits = {
  pageCount: 64,
  pageBytes: 8 * 1024 * 1024,
  globalCount: 256,
  globalBytes: 32 * 1024 * 1024,
};

export class PageQueues {
  private readonly queues = new Map<string, PageQueue>();
  private accepting = true;
  readonly metrics: QueueMetrics = {
    admitted: 0,
    completed: 0,
    failures: 0,
    rejected: 0,
    pendingCount: 0,
    pendingBytes: 0,
    waitMs: 0,
    processingMs: 0,
  };

  constructor(private readonly limits: QueueLimits = DEFAULT_LIMITS) {}

  get pageIds(): readonly string[] { return [...this.queues.keys()]; }

  async run<T>(pageId: string, bytes: number, task: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new ShutdownError('Server is draining');
    let page = this.queues.get(pageId);
    if (!page) {
      page = { queue: new PQueue({ concurrency: 1 }), count: 0, bytes: 0 };
      this.queues.set(pageId, page);
    }
    if (this.exceedsLimits(page, bytes)) {
      if (page.count === 0) this.queues.delete(pageId);
      this.metrics.rejected++;
      throw new OverloadError('Synchronization queue is full');
    }
    page.count++;
    page.bytes += bytes;
    this.metrics.pendingCount++;
    this.metrics.pendingBytes += bytes;
    this.metrics.admitted++;
    const admittedAt = performance.now();
    try {
      return await page.queue.add(async () => {
        const startedAt = performance.now();
        this.metrics.waitMs += startedAt - admittedAt;
        try {
          if (!this.accepting) throw new ShutdownError('Server is draining');
          const result = await task();
          this.metrics.completed++;
          return result;
        } catch (error) {
          this.metrics.failures++;
          throw error;
        } finally {
          this.metrics.processingMs += performance.now() - startedAt;
        }
      }) as T;
    } finally {
      page.count--;
      page.bytes -= bytes;
      this.metrics.pendingCount--;
      this.metrics.pendingBytes -= bytes;
      if (page.count === 0) this.queues.delete(pageId);
    }
  }

  private exceedsLimits(page: PageQueue, bytes: number): boolean {
    return page.count >= this.limits.pageCount
      || page.bytes + bytes > this.limits.pageBytes
      || this.metrics.pendingCount >= this.limits.globalCount
      || this.metrics.pendingBytes + bytes > this.limits.globalBytes;
  }

  async drain(): Promise<void> {
    this.accepting = false;
    // Waiting tasks reject when reached. Running work owns its slot until the
    // database operation completes or rolls back; no timeout races COMMIT.
    await Promise.all([...this.queues.values()].map(page => page.queue.onIdle()));
  }
}
