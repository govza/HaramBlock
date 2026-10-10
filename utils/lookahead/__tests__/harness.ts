import { readFileSync } from 'node:fs';

import type {
  AnalysisFrame,
  ByteRangeSource,
  DecoderPort,
  InferencePort,
  InferredSample,
  LookaheadEvents,
  SampleCachePort,
  StoredSample,
  UnreachableReason,
} from '@/utils/lookahead/ports';

export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`utils/lookahead/__tests__/fixtures/${name}`));

export const CLEAN: InferredSample = {
  predictions: [],
  input: { width: 64, height: 36, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
  topUnsafeScore: 0.05,
};

export const unsafe = (probability = 0.6): InferredSample => ({
  ...CLEAN,
  topUnsafeScore: probability,
  predictions: [
    {
      classId: 1,
      className: 'unsafe',
      probability,
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      masks: { width: 1, height: 1, startValue: 1, runs: [1] },
    },
  ],
});

export const suspicious = (score = 0.3): InferredSample => ({ ...CLEAN, topUnsafeScore: score });

export interface TestFrame extends AnalysisFrame {
  ptsUs: number;
  closed: boolean;
}

export interface InferenceRequest {
  pointUs: number;
  ptsUs: number;
  priority: number;
}

export function createHarness(
  options: { verdictAt?: (pointUs: number) => InferredSample; cached?: StoredSample[] } = {},
) {
  const requests: InferenceRequest[] = [];
  const frames: TestFrame[] = [];
  const published: StoredSample[] = [];
  const emitted: StoredSample[] = [];
  const unreachable: UnreachableReason[] = [];
  let cacheReads = 0;
  let decodeJobs = 0;
  const verdictAt = options.verdictAt ?? (() => CLEAN);

  const decoder: DecoderPort = {
    async *decode(job) {
      decodeJobs += 1;
      for (const target of [...job.targets].sort((a, b) => a.ptsUs - b.ptsUs)) {
        const frame: TestFrame = {
          ptsUs: target.ptsUs,
          closed: false,
          close() {
            this.closed = true;
          },
        };
        frames.push(frame);
        await Promise.resolve();
        yield { target, frame };
      }
    },
  };

  const inference: InferencePort = {
    infer({ pointUs, frame, priority }) {
      requests.push({ pointUs, ptsUs: (frame as TestFrame).ptsUs, priority });
      return Promise.resolve(verdictAt(pointUs));
    },
  };

  const cache: SampleCachePort = {
    read() {
      cacheReads += 1;
      return Promise.resolve(options.cached ?? []);
    },
    publish(samples) {
      published.push(...samples);
    },
  };

  const events: LookaheadEvents = {
    sample: sample => emitted.push(sample),
    unreachable: reason => unreachable.push(reason),
  };

  return {
    ports: { decoder, inference, cache, events },
    requests,
    frames,
    published,
    emitted,
    unreachable,
    cacheReads: () => cacheReads,
    decodeJobs: () => decodeJobs,
    requestedPoints: () => requests.map(request => request.pointUs),
  };
}

export function chunked(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes[index % sizes.length] ?? bytes.length;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

export function fileSource(bytes: Uint8Array, options: { failFirst?: boolean } = {}) {
  const reads: [number, number][] = [];
  const source: ByteRangeSource = {
    size: () => (options.failFirst ? Promise.reject(new Error('403')) : Promise.resolve(bytes.length)),
    read(start, end) {
      reads.push([start, end]);
      return Promise.resolve(bytes.slice(start, end));
    },
  };
  return { source, reads };
}
