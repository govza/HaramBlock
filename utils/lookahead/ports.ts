import type { IElementPrediction, IMaskTransform } from '@/utils/types';

export interface SampleInput {
  width: number;
  height: number;
  maskTransform: IMaskTransform;
}

export interface InferredSample {
  predictions: IElementPrediction[];
  input: SampleInput;
  topUnsafeScore: number;
}

export interface StoredSample extends InferredSample {
  pointUs: number;
}

export interface AnalysisFrame {
  close(): void;
}

export interface EncodedSample {
  data: Uint8Array;
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
}

export interface DecodeTarget {
  pointUs: number;
  ptsUs: number;
}

export interface DecodeJob {
  config: VideoDecoderConfig;
  packets: EncodedSample[];
  targets: DecodeTarget[];
}

export interface DecodedTarget {
  target: DecodeTarget;
  frame: AnalysisFrame;
}

export interface DecoderPort {
  decode(job: DecodeJob): AsyncIterable<DecodedTarget>;
}

export interface InferenceRequest {
  pointUs: number;
  frame: AnalysisFrame;
  priority: number;
}

export interface InferencePort {
  infer(request: InferenceRequest): Promise<InferredSample>;
}

export interface SampleCachePort {
  read(): Promise<StoredSample[]>;
  publish(samples: StoredSample[]): void;
}

export type UnreachableReason = 'hook' | 'overflow' | 'fetch' | 'demux' | 'decode';

export type AnalysisStat =
  | { kind: 'analysed'; pointUs: number }
  | { kind: 'cacheHit'; pointUs: number }
  | { kind: 'unitDemuxFailed' }
  | { kind: 'decodeFailed' }
  | { kind: 'cacheReadFailed' };

export interface LookaheadEvents {
  sample(sample: StoredSample): void;
  unreachable(reason: UnreachableReason): void;
  stat?(stat: AnalysisStat): void;
}

export interface LookaheadPorts {
  decoder: DecoderPort;
  inference: InferencePort;
  cache: SampleCachePort;
  events: LookaheadEvents;
}

export interface ByteRangeSource {
  size(): Promise<number>;
  read(start: number, end: number): Promise<Uint8Array>;
}

export type Liveness = 'live' | 'vod' | 'unknown';

export function combinedLiveness(...readings: readonly Liveness[]): Liveness {
  if (readings.includes('live')) return 'live';
  if (readings.includes('unknown')) return 'unknown';
  return 'vod';
}

export function livenessOfDuration(durationSec: number): Liveness {
  if (durationSec === Number.POSITIVE_INFINITY) return 'live';
  return Number.isFinite(durationSec) && durationSec > 0 ? 'vod' : 'unknown';
}

export interface LookaheadOptions {
  liveness: Liveness;
  suspicionThreshold: number;
}

export interface Playhead {
  timeSec: number;
  playbackRate: number;
  paused: boolean;
}

export const isUnsafeSample = (sample: InferredSample): boolean => sample.predictions.length > 0;
