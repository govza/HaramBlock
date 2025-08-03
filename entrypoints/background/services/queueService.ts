import PQueue from 'p-queue';

import { type InferenceTask } from '@/entrypoints/background/domain/models';
import { logger } from '@/utils/logger';

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

  setTaskProcessingHandler(
    handler: (task: InferenceTask) => Promise<void>,
  ): void {
    this.onTaskProcessing = handler;
  }

  enqueue(task: InferenceTask): Promise<void> {
    logger
      .withTag('queueService')
      .debug(`Enqueueing task ${task.id} with priority ${task.priority}`);

    // Return the promise to allow proper tracking of task completion
    return this.queue.add(
      async () => {
        if (this.onTaskProcessing) {
          logger.withTag('queueService').debug(`Processing task ${task.id}`);
          await this.onTaskProcessing(task);
          logger.withTag('queueService').debug(`Completed task ${task.id}`);
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
    return (
      this.queue.isPaused === false &&
      this.queue.size === 0 &&
      this.queue.pending === 0
    );
  }

  pause(): void {
    logger.withTag('queueService').debug('Pausing queue');
    this.queue.pause();
  }

  start(): void {
    logger.withTag('queueService').debug('Starting queue');
    this.queue.start();
  }

  clear(): void {
    logger.withTag('queueService').debug('Clearing queue');
    this.queue.clear();
  }

  onEmpty(): Promise<void> {
    return this.queue.onEmpty();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }
}
