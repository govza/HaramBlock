import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchCollector, type BatchItemResult } from '@/entrypoints/background/services/batchCollector';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ok = <T>(tasks: T[]): Array<BatchItemResult<T>> => tasks.map(task => ({ result: task }));

describe('BatchCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes a lone task as a batch of 1 after a tick', async () => {
    const processBatch = vi.fn((tasks: number[]) => Promise.resolve(tasks.map(t => ({ result: t * 2 }))));
    const collector = new BatchCollector<number, number>(processBatch, { getCap: () => 4 });

    const result = collector.submit(5);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(10);
    expect(processBatch).toHaveBeenCalledExactlyOnceWith([5]);
  });

  it('flushes immediately once the buffer reaches the cap', () => {
    const processBatch = vi.fn((tasks: number[]) => Promise.resolve(ok(tasks)));
    const collector = new BatchCollector<number, number>(processBatch, { getCap: () => 2 });

    void collector.submit(1);
    void collector.submit(2);

    // No timer advance: hitting the cap dispatches synchronously.
    expect(processBatch).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it('coalesces tasks submitted during a run into the next batch (GPU-busy window)', async () => {
    const calls: number[][] = [];
    const gate = deferred<void>();
    const processBatch = vi.fn(async (tasks: number[]) => {
      calls.push(tasks);
      if (calls.length === 1) await gate.promise;
      return ok(tasks);
    });
    const collector = new BatchCollector<number, number>(processBatch, { getCap: () => 4 });

    const p1 = collector.submit(1);
    await vi.advanceTimersByTimeAsync(0); // batch [1] now running, awaiting the gate

    const rest = [2, 3, 4].map(n => collector.submit(n));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([[1]]); // still parked behind the running batch

    gate.resolve();
    await vi.runAllTimersAsync();
    await Promise.all([p1, ...rest]);

    expect(calls).toEqual([[1], [2, 3, 4]]);
  });

  it('flushes higher-priority tasks first', async () => {
    const calls: number[][] = [];
    const gate = deferred<void>();
    const processBatch = vi.fn(async (tasks: Array<{ id: number; priority: number }>) => {
      calls.push(tasks.map(t => t.id));
      if (calls.length === 1) await gate.promise;
      return ok(tasks);
    });
    const collector = new BatchCollector<{ id: number; priority: number }, { id: number; priority: number }>(
      processBatch,
      { getCap: () => 2, getPriority: task => task.priority },
    );

    void collector.submit({ id: 0, priority: 0 });
    await vi.advanceTimersByTimeAsync(0); // opens the busy window with [0]

    void collector.submit({ id: 1, priority: 1 });
    void collector.submit({ id: 2, priority: 5 });
    void collector.submit({ id: 3, priority: 3 });

    gate.resolve();
    await vi.runAllTimersAsync();

    expect(calls[0]).toEqual([0]);
    expect(calls[1]).toEqual([2, 3]); // top two by priority
    expect(calls[2]).toEqual([1]); // leftover
  });

  it('isolates a per-item error without failing the batch', async () => {
    const processBatch = vi.fn((tasks: number[]) =>
      Promise.resolve(tasks.map(t => (t === 2 ? { error: new Error('bad image') } : { result: t }))),
    );
    const collector = new BatchCollector<number, number>(processBatch, { getCap: () => 4 });

    const p1 = collector.submit(1);
    const p2 = collector.submit(2);
    // Attach the rejection handler before timers settle the promise, else it reads as unhandled.
    const rejected = expect(p2).rejects.toThrow('bad image');
    await vi.runAllTimersAsync();

    await expect(p1).resolves.toBe(1);
    await rejected;
  });

  it('rejects every task in the batch when processBatch throws', async () => {
    const processBatch = vi.fn(() => Promise.reject(new Error('boom')));
    const collector = new BatchCollector<number, number>(processBatch, { getCap: () => 4 });

    const p1 = collector.submit(1);
    const p2 = collector.submit(2);
    // Attach rejection handlers before timers settle the promises, else they read as unhandled.
    const rejected = Promise.all([expect(p1).rejects.toThrow('boom'), expect(p2).rejects.toThrow('boom')]);
    await vi.runAllTimersAsync();

    await rejected;
  });
});
