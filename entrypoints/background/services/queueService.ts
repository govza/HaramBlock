import PQueue from 'p-queue';

import { type InferenceTask } from '@/utils/types';

export class QueueService {
  private queue: PQueue;
  private onTaskProcessing?: (task: InferenceTask) => Promise<void>;

  constructor(options?: { concurrency?: number }) {
    this.queue = new PQueue({
      concurrency: options?.concurrency || 1,
      interval: 0,
      intervalCap: 1,
    });
  }

  setTaskProcessingHandler(handler: (task: InferenceTask) => Promise<void>): void {
    this.onTaskProcessing = handler;
  }

  enqueue(task: InferenceTask): Promise<void> {
    // p-queue: higher priority number = runs first
    return this.queue.add(
      async () => {
        if (this.onTaskProcessing) {
          await this.onTaskProcessing(task);
        }
      },
      { priority: task.priority },
    );
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  getPendingCount(): number {
    return this.queue.pending;
  }

  isIdle(): boolean {
    return this.queue.isPaused === false && this.queue.size === 0 && this.queue.pending === 0;
  }

  pause(): void {
    this.queue.pause();
  }

  start(): void {
    this.queue.start();
  }

  clear(): void {
    this.queue.clear();
  }

  onEmpty(): Promise<void> {
    return this.queue.onEmpty();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }
}
