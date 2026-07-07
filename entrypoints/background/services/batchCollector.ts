/** Result slot for one submitted task: a value or the error that isolated it. */
export interface BatchItemResult<TResult> {
  result?: TResult;
  error?: Error;
}

interface Pending<TTask, TResult> {
  task: TTask;
  resolve: (result: TResult) => void;
  reject: (error: unknown) => void;
}

interface BatchCollectorOptions<TTask> {
  /** Max tasks per batch for the active model (re-read each flush; 1 disables batching). */
  getCap: () => number;
  /** Higher value flushed first - preserves active-tab priority when forming a batch. */
  getPriority?: (task: TTask) => number;
}

/**
 * Coalesces submitted tasks into batched calls to `processBatch`.
 *
 * Self-tuning via the GPU-busy window: only one batch is processed at a time, so tasks submitted
 * while a batch runs accumulate and flush together once it finishes. Under load batches grow toward
 * the cap; when idle a lone task flushes on the next tick (batch 1), so single-image latency on the
 * active tab never regresses. The serialized run also satisfies the one-session.run-at-a-time
 * constraint of onnxruntime-web (see docs/INFERENCE_PIPELINE.md).
 */
export class BatchCollector<TTask, TResult> {
  private buffer: Array<Pending<TTask, TResult>> = [];
  private running = false;
  private flushScheduled = false;

  constructor(
    private readonly processBatch: (tasks: TTask[]) => Promise<Array<BatchItemResult<TResult>>>,
    private readonly options: BatchCollectorOptions<TTask>,
  ) {}

  submit(task: TTask): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      this.buffer.push({ task, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.running || this.buffer.length === 0) return;

    // A full batch flushes immediately; a partial one waits a tick to coalesce a burst of arrivals.
    if (this.buffer.length >= this.options.getCap()) {
      void this.flush();
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      void this.flush();
    }, 0);
  }

  private async flush(): Promise<void> {
    if (this.running || this.buffer.length === 0) return;
    this.running = true;

    const cap = Math.max(1, this.options.getCap());
    const { getPriority } = this.options;
    if (getPriority) {
      this.buffer.sort((a, b) => getPriority(b.task) - getPriority(a.task));
    }
    const batch = this.buffer.splice(0, cap);

    try {
      const results = await this.processBatch(batch.map(p => p.task));
      batch.forEach((pending, i) => {
        const item = results[i];
        if (item?.error) {
          pending.reject(item.error);
        } else if (item && 'result' in item) {
          pending.resolve(item.result as TResult);
        } else {
          pending.reject(new Error('BatchCollector: no result returned for task'));
        }
      });
    } catch (error) {
      batch.forEach(pending => pending.reject(error));
    } finally {
      this.running = false;
      this.scheduleFlush();
    }
  }
}
