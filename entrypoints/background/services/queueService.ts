import PQueue from 'p-queue';

import { type InferenceTask } from '@/utils/types';

export class QueueService {
  private queue: PQueue;
  private onTaskProcessing?: (task: InferenceTask) => Promise<void>;

  constructor() {
    this.queue = new PQueue({
      concurrency: 1,
      interval: 0,
      intervalCap: 1,
    });
  }

  setTaskProcessingHandler(handler: (task: InferenceTask) => Promise<void>): void {
    this.onTaskProcessing = handler;
  }

  setConcurrency(concurrency: number): void {
    this.queue.concurrency = Math.max(1, concurrency);
  }

  enqueue(task: InferenceTask, signal?: AbortSignal): Promise<void> {
    // p-queue: higher priority number = runs first
    return this.queue.add(
      async () => {
        if (this.onTaskProcessing) {
          await this.onTaskProcessing(task);
        }
      },
      { priority: task.priority, signal },
    );
  }
}
