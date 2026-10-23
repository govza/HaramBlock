import { mediaReferenceFrom, type MediaReference, type PersistentVideoIdentity } from '@/utils/videoIdentity';

import type {
  AnalysisStat,
  InferredSample,
  Liveness,
  Playhead,
  SessionReadContext,
  StoredSample,
  UnreachableReason,
} from '@/utils/lookahead/ports';
import type { CachedSampleReader } from '@/utils/lookahead/sampleQuality';
import type { IVideoCacheOrigin } from '@/utils/types';

export const MSE_HOOK_HANDSHAKE = '__haramblockMseHookPort';
export const LOOKAHEAD_PORT_NAME = 'hb-lookahead';
export const LOOKAHEAD_HOST_PAGE = '/lookahead-host.html' as const;
export const HOOK_IDENTITY_ATTR = 'data-hb-video-identity';

/**
 * The MSE hook's current Media Reference for the `MediaSource` a `<video>` plays, published as JSON
 * on the element so the content script can read it synchronously when the source changes.
 */
export interface HookIdentityClaim {
  objectUrl: string;
  reference: MediaReference;
}

export const encodeHookIdentityClaim = (claim: HookIdentityClaim): string => JSON.stringify(claim);

export function decodeHookIdentityClaim(raw: string | null): HookIdentityClaim | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const objectUrl: unknown = Reflect.get(parsed, 'objectUrl');
  const reference = mediaReferenceFrom(Reflect.get(parsed, 'reference'));
  return typeof objectUrl === 'string' && reference ? { objectUrl, reference } : null;
}

export type FirefoxPortMessage = { k: 'hook'; m: HookMessage } | { k: 'content'; m: ContentToHost };

/**
 * An `EncodedVideoChunk` from `appendEncodedChunks`, copied into a transferable buffer for the host.
 */
export interface WireChunk {
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
  data: ArrayBuffer;
}

export type HookMessage =
  | { t: 'source'; sourceId: number; objectUrl: string; liveness: Liveness }
  | { t: 'liveness'; sourceId: number; liveness: Liveness }
  | { t: 'buffer'; sourceId: number; bufferId: number; mime: string }
  | { t: 'changeType'; sourceId: number; bufferId: number; mime: string }
  | {
      t: 'append';
      sourceId: number;
      bufferId: number;
      bytes: ArrayBuffer;
      timestampOffset: number;
      discontinuity?: boolean;
    }
  | { t: 'chunks'; sourceId: number; bufferId: number; config: VideoDecoderConfig; chunks: WireChunk[] }
  | { t: 'endOfStream'; sourceId: number; bufferId: number }
  | { t: 'removeBuffer'; sourceId: number; bufferId: number }
  | { t: 'overflow'; sourceId: number };

export type HookCommand = { t: 'want'; sourceId: number } | { t: 'drop'; sourceId: number };

export type TapRequest = { kind: 'mse'; objectUrl: string } | { kind: 'progressive'; url: string };

export type TapKind = 'mse' | 'progressive' | 'none';

/**
 * The content script's request to start Lookahead Analysis for a VideoSession; re-sending it for the same session
 * replaces the analysis.
 */
export interface OpenAnalysis {
  t: 'open';
  sessionId: string;
  tap: TapRequest;
  liveness: Liveness;
  inputSize: number;
  readContext: SessionReadContext;
  origin: IVideoCacheOrigin;
  scoreThreshold: number;
}

export type ContentToHost =
  | OpenAnalysis
  | { t: 'playhead'; sessionId: string; playhead: Playhead }
  | { t: 'visible'; sessionId: string; visible: boolean }
  | { t: 'liveness'; sessionId: string; liveness: Liveness }
  | { t: 'readContext'; sessionId: string; readContext: SessionReadContext }
  | { t: 'close'; sessionId: string }
  | { t: 'inferResult'; requestId: number; sample: InferredSample | null }
  | { t: 'cacheSamples'; requestId: number; samples: StoredSample[] };

export type HostToContent =
  | { t: 'reachable'; sessionId: string; tap: Exclude<TapKind, 'none'> }
  | { t: 'unreachable'; sessionId: string; reason: UnreachableReason }
  | { t: 'sample'; sessionId: string; sample: StoredSample }
  | { t: 'stat'; sessionId: string; stat: AnalysisStat }
  | {
      t: 'infer';
      requestId: number;
      sessionId: string;
      pointUs: number;
      bitmap: ImageBitmap;
      originalWidth: number;
      originalHeight: number;
      priority: number;
    }
  | {
      t: 'cacheRead';
      requestId: number;
      sessionId: string;
      identity: PersistentVideoIdentity;
      reader: CachedSampleReader;
    }
  | { t: 'cachePublish'; sessionId: string; identity: PersistentVideoIdentity; samples: StoredSample[] }
  | { t: 'toHook'; command: HookCommand };

export const isArrayBufferTag = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';
