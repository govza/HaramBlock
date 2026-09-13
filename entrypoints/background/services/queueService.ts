import PQueue from 'p-queue';

import { getMeter, METRIC } from '@/utils/telemetry';
import { type InferenceTask } from '@/utils/types';

export class QueueService {
  private queue: PQueue;
  private onTaskProcessing?: (task: InferenceTask) => Promise<void>;
  private readonly queuedIds = new Set<string>();

  constructor() {
    this.queue = new PQueue({
      concurrency: 1,
      interval: 0,
      intervalCap: 1,
    });
    getMeter('inference')
      .createObservableGauge(METRIC.inferenceQueueDepth)
      .addCallback(result => result.observe(this.queue.size + this.queue.pending));
  }

  setTaskProcessingHandler(handler: (task: InferenceTask) => Promise<void>): void {
    this.onTaskProcessing = handler;
  }

  setConcurrency(concurrency: number): void {
    this.queue.concurrency = Math.max(1, concurrency);
  }

  isIdle(): boolean {
    return this.queue.size === 0 && this.queue.pending === 0;
  }

  /** Fires every time the queue drains (PQueue 'idle' event). Returns an unsubscribe function. */
  onIdle(callback: () => void): () => void {
    this.queue.on('idle', callback);
    return () => this.queue.off('idle', callback);
  }

  enqueue(task: InferenceTask, signal?: AbortSignal, id?: string): Promise<void> {
    if (id) this.queuedIds.add(id);
    // p-queue: higher priority number = runs first
    return this.queue
      .add(
        async () => {
          if (id) this.queuedIds.delete(id);
          if (this.onTaskProcessing) {
            await this.onTaskProcessing(task);
          }
        },
        { priority: task.priority, signal, id },
      )
      .finally(() => {
        if (id) this.queuedIds.delete(id);
      });
  }

  raisePriority(id: string, priority: number): void {
    if (!this.queuedIds.has(id)) return;
    this.queue.setPriority(id, priority);
  }
}
