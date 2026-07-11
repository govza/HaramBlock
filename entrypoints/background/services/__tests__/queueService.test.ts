import { describe, expect, it, vi } from 'vitest';

import { QueueService } from '@/entrypoints/background/services/queueService';

import type { InferenceTask } from '@/utils/types';

function task(imageSrc: string, priority = 0): InferenceTask {
  return { imageSrc, priority } as InferenceTask;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('QueueService', () => {
  it('removes an aborted video frame before it starts', async () => {
    const queue = new QueueService();
    const gate = deferred();
    const started: string[] = [];
    queue.setTaskProcessingHandler(async queued => {
      started.push(queued.imageSrc);
      if (queued.imageSrc === 'running') await gate.promise;
    });

    const running = queue.enqueue(task('running'));
    await vi.waitFor(() => expect(started).toEqual(['running']));

    const controller = new AbortController();
    const stale = queue.enqueue(task('stale-frame'), controller.signal);
    const latest = queue.enqueue(task('latest-frame'));
    controller.abort();
    const staleRejected = expect(stale).rejects.toBeDefined();

    gate.resolve();
    await Promise.all([running, latest, staleRejected]);
    expect(started).toEqual(['running', 'latest-frame']);
  });
});
