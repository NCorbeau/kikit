import { describe, expect, it } from 'vitest';
import { PageQueues, OverloadError, ShutdownError } from './queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('page sequencing', () => {

  it('serializes one page while other pages proceed and releases accounting on failure', async () => {
    const queues = new PageQueues();
    const gate = deferred();
    const order: string[] = [];
    const first = queues.run('one', 10, async () => {
      order.push('first started');
      await gate.promise;
      order.push('first finished');
    });
    const second = queues.run('one', 20, async () => {
      order.push('second');
      throw new Error('rollback');
    });
    const failure = expect(second).rejects.toThrow('rollback');
    await queues.run('two', 30, async () => {
      order.push('other page');
    });
    expect(order).toEqual(['first started', 'other page']);
    expect(queues.metrics.pendingBytes).toBe(30);
    gate.resolve();
    await first;
    await failure;
    expect(order).toEqual(['first started', 'other page', 'first finished', 'second']);
    expect(queues.metrics.pendingCount).toBe(0);
    expect(queues.metrics.pendingBytes).toBe(0);
    expect(queues.metrics.failures).toBe(1);
  });

  it('bounds active and waiting work by count and bytes', async () => {
    const queues = new PageQueues({
      pageCount: 2,
      pageBytes: 10,
      globalCount: 3,
      globalBytes: 12
    });
    const gate = deferred();
    const first = queues.run('one', 8, () => gate.promise);
    await expect(queues.run('one', 3, async () => undefined)).rejects.toBeInstanceOf(OverloadError);
    const second = queues.run('one', 2, async () => undefined);
    await expect(queues.run('one', 0, async () => undefined)).rejects.toBeInstanceOf(OverloadError);
    await expect(queues.run('two', 3, async () => undefined)).rejects.toBeInstanceOf(OverloadError);
    gate.resolve();
    await Promise.all([first, second]);
    expect(queues.metrics.rejected).toBe(3);
  });

  it('drains the running operation before resolving shutdown and rejects waiting mutations', async () => {
    const queues = new PageQueues();
    const gate = deferred();
    let ranQueued = false;
    let drained = false;
    const first = queues.run('one', 1, () => gate.promise);
    const waiting = queues.run('one', 1, async () => {
      ranQueued = true;
    });
    const failure = expect(waiting).rejects.toBeInstanceOf(ShutdownError);
    const drain = queues.drain().then(() => {
      drained = true;
    });
    await expect(queues.run('two', 1, async () => undefined)).rejects.toBeInstanceOf(ShutdownError);
    expect(drained).toBe(false);
    gate.resolve();
    await first;
    await failure;
    await drain;
    expect(ranQueued).toBe(false);
    expect(queues.metrics.pendingCount).toBe(0);
  });
});
