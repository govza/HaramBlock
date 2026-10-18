import type { CachedSampleReader } from '@/utils/lookahead/sampleQuality';
import type { IFrameSize, IMaskTransform, RawSampleScores } from '@/utils/types';
import type { PersistentVideoIdentity, VideoIdentity } from '@/utils/videoIdentity';

/**
 * Geometry of the model input a sample was inferred from, needed to map its scores back onto the video.
 */
export interface SampleInput {
  width: number;
  height: number;
  maskTransform: IMaskTransform;
}

/**
 * Strictness-independent inference result for one frame: raw floor-threshold scores each reader thresholds itself.
 */
export interface InferredSample {
  scores: RawSampleScores;
  input: SampleInput;
  topUnsafeScore: number;
  source?: IFrameSize;
}

/**
 * An inferred sample pinned to the Lattice Point (or Keyframe Point) it describes; the unit the verdict cache stores.
 */
export interface StoredSample extends InferredSample {
  pointUs: number;
}

/**
 * A decoded frame handed from the decoder to inference; the owner must `close()` it once inferred or dropped.
 */
export interface AnalysisFrame {
  close(): void;
}

/**
 * One encoded video packet in page media time.
 */
export interface EncodedSample {
  data: Uint8Array;
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
}

/**
 * A Lattice Point to sample and the PTS of the frame presented at it (the last frame with PTS <= point), both in µs.
 */
export interface DecodeTarget {
  pointUs: number;
  ptsUs: number;
}

/**
 * A decodable run of packets starting at a keyframe, plus the frames within it that must be emitted for inference.
 */
export interface DecodeJob {
  config: VideoDecoderConfig;
  packets: EncodedSample[];
  targets: DecodeTarget[];
}

/**
 * A decoded frame matched back to the target it was decoded for.
 */
export interface DecodedTarget {
  target: DecodeTarget;
  frame: AnalysisFrame;
}

/**
 * Decodes jobs off the page, yielding only the target frames; WebCodecs in the host, fakes in tests.
 */
export interface DecoderPort {
  decode(job: DecodeJob): AsyncIterable<DecodedTarget>;
}

/**
 * A `DecoderPort` that also answers, without decoding, whether it can take a job with this config.
 */
export interface CapableDecoder extends DecoderPort {
  readonly kind: 'webcodecs' | 'wasm';
  supports(config: VideoDecoderConfig): Promise<boolean>;
}

/**
 * A frame to infer for a Lattice Point, at the priority the scheduler derived from its distance to the playhead.
 */
export interface InferenceRequest {
  pointUs: number;
  frame: AnalysisFrame;
  priority: number;
}

/**
 * Sends frames through the shared background inference pipeline.
 */
export interface InferencePort {
  infer(request: InferenceRequest): Promise<InferredSample>;
}

/**
 * The persistent verdict cache, addressed by the session's video identity: read once that identity is known,
 * published to as samples are inferred.
 */
export interface SampleCachePort {
  read(identity: PersistentVideoIdentity, reader: CachedSampleReader): Promise<StoredSample[]>;
  publish(identity: PersistentVideoIdentity, samples: StoredSample[]): void;
}

export type UnreachableReason = 'hook' | 'overflow' | 'fetch' | 'demux' | 'decode';

export type AnalysisStat =
  | { kind: 'analysed'; pointUs: number }
  | { kind: 'cacheHit'; pointUs: number }
  | { kind: 'unitDemuxFailed' }
  | { kind: 'decodeFailed' }
  | { kind: 'cacheReadFailed' };

/**
 * Callbacks through which an analysis reports samples, a lost tap and telemetry to its session.
 */
export interface LookaheadEvents {
  sample(sample: StoredSample): void;
  unreachable(reason: UnreachableReason): void;
  stat?(stat: AnalysisStat): void;
}

/**
 * Everything an analysis needs from its environment, so the DOM-free core runs unchanged in the host and in tests.
 */
export interface LookaheadPorts {
  decoder: DecoderPort;
  inference: InferencePort;
  cache: SampleCachePort;
  events: LookaheadEvents;
}

/**
 * Random access to a Progressive Source's bytes, read with HTTP range requests.
 */
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

/**
 * What the content script learns about the playing media after a session opens, deciding how the
 * analysis uses the persistent cache: the identity it reads and publishes under, and the playing
 * aspect ratio its cache read guards against.
 */
export interface SessionReadContext {
  identity: VideoIdentity;
  aspectRatio: number | null;
}

/**
 * Per-session settings an analysis starts with.
 */
export interface LookaheadOptions {
  liveness: Liveness;
  scoreThreshold: number;
  readContext: SessionReadContext;
}

/**
 * The video element's playback position, which the scheduler uses to prioritise points ahead of it.
 */
export interface Playhead {
  timeSec: number;
  playbackRate: number;
  paused: boolean;
}
