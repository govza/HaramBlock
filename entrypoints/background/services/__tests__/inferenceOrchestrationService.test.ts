import { describe, expect, it, vi } from 'vitest';

import { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import { QueueService } from '@/entrypoints/background/services/queueService';
import { DEFAULT_HOST_SETTINGS } from '@/utils/constants/hostsettings';

import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { IImagePrediction, IMediaMetadata, ImageInferenceResult, InferenceTask } from '@/utils/types';

const { processInferenceTask, gates } = vi.hoisted(() => {
  const gates = new Map<string, () => void>();
  const processInferenceTask = vi.fn(
    (task: { imageSrc: string }) =>
      new Promise<IImagePrediction>(resolve => {
        gates.set(task.imageSrc, () =>
          resolve({
            src: task.imageSrc,
            hostname: 'example.com',
            width: 100,
            height: 100,
            predictions: [],
            timestamp: 0,
            cacheMetadata: { createdAt: 0, accessedAt: 0 },
            maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
            processingTime: {
              fetchTime: 0,
              decodeTime: 0,
              queueTime: 0,
              inferenceTime: 0,
              e2eTime: 0,
              backend: 'wasm',
            },
            forcedVisibility: 'auto',
          }),
        );
      }),
  );
  return { processInferenceTask, gates };
});

vi.mock('@inference-runtime', () => ({ getCurrentModelId: () => 'test-model' }));
vi.mock('@/utils/inference', () => ({
  getBatchCap: () => 1,
  getInferenceBackend: () => 'wasm',
  processInferenceBatch: vi.fn(),
  processInferenceTask,
}));
vi.mock('@/entrypoints/background/services/batchCollector', () => ({
  BatchCollector: class {
    submit = vi.fn();
  },
}));

const cacheService = {
  getCachedPredictionsBySrc: vi.fn(() => Promise.resolve([])),
  cachePredictions: vi.fn(() => Promise.resolve()),
} as unknown as ImageCacheService;

function setup() {
  const queue = new QueueService();
  const service = new InferenceOrchestrationService(queue, cacheService);
  const results: ImageInferenceResult[] = [];
  service.setOnImagePredictionsCallback(batch => results.push(...batch));
  const schedule = (imageSrc: string, priority = 0) =>
    service.scheduleInferenceTask({
      input: { kind: 'src', imageSrc },
      hostname: 'example.com',
      hostSettings: DEFAULT_HOST_SETTINGS,
      mediaMetadata: { kind: 'image' } as IMediaMetadata,
      priority,
    });
  return { service, queue, results, schedule };
}

const statuses = (results: ImageInferenceResult[], src: string) =>
  results
    .filter(result => (result.status === 'ok' ? result.prediction.src : result.src) === src)
    .map(result => result.status);

const release = (src: string) => {
  gates.get(src)?.();
  gates.delete(src);
};

describe('InferenceOrchestrationService image dedupe', () => {
  it('broadcasts started when the task leaves the queue and ok when it completes', async () => {
    const { results, schedule } = setup();
    await schedule('a');
    await vi.waitFor(() => expect(statuses(results, 'a')).toEqual(['started']));
    release('a');
    await vi.waitFor(() => expect(statuses(results, 'a')).toEqual(['started', 'ok']));
    expect(processInferenceTask).toHaveBeenCalledTimes(1);
  });

  it('joins a queued duplicate instead of running it twice and raises its priority', async () => {
    const { results, schedule } = setup();
    await schedule('running');
    await vi.waitFor(() => expect(statuses(results, 'running')).toEqual(['started']));
    await schedule('queued', 0);
    await schedule('queued', 30);

    release('running');
    await vi.waitFor(() => expect(statuses(results, 'queued')).toEqual(['started']));
    const queuedTask = processInferenceTask.mock.calls.at(-1)?.[0] as InferenceTask;
    expect(queuedTask.priority).toBe(30);
    release('queued');
    await vi.waitFor(() => expect(statuses(results, 'queued')).toEqual(['started', 'ok']));
    expect(processInferenceTask).toHaveBeenCalledTimes(2);
  });

  it('re-broadcasts started for a duplicate that joins an already running task', async () => {
    const { results, schedule } = setup();
    await schedule('a');
    await vi.waitFor(() => expect(statuses(results, 'a')).toEqual(['started']));
    await schedule('a');
    expect(statuses(results, 'a')).toEqual(['started', 'started']);
    release('a');
    await vi.waitFor(() => expect(statuses(results, 'a')).toEqual(['started', 'started', 'ok']));
    expect(processInferenceTask).toHaveBeenCalledTimes(1);
  });

  it('runs the same src again once the previous task has finished', async () => {
    const { results, schedule } = setup();
    await schedule('a');
    await vi.waitFor(() => expect(statuses(results, 'a')).toEqual(['started']));
    release('a');
    await vi.waitFor(() => expect(statuses(results, 'a')).toEqual(['started', 'ok']));
    await schedule('a');
    await vi.waitFor(() => expect(processInferenceTask).toHaveBeenCalledTimes(2));
    release('a');
  });
});
