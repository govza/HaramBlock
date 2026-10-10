import type { AnalysisStat, InferredSample, Playhead, StoredSample, UnreachableReason } from '@/utils/lookahead/ports';

export const MSE_HOOK_HANDSHAKE = '__haramblockMseHookPort';
export const LOOKAHEAD_PORT_NAME = 'hb-lookahead';
export const LOOKAHEAD_HOST_PAGE = '/lookahead-host.html' as const;

export type FirefoxPortMessage = { k: 'hook'; m: HookMessage } | { k: 'content'; m: ContentToHost };

export interface WireChunk {
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
  data: ArrayBuffer;
}

export type HookMessage =
  | { t: 'source'; sourceId: number; objectUrl: string; live: boolean }
  | { t: 'buffer'; sourceId: number; bufferId: number; mime: string }
  | { t: 'changeType'; sourceId: number; bufferId: number; mime: string }
  | { t: 'append'; sourceId: number; bufferId: number; bytes: ArrayBuffer; timestampOffset: number }
  | { t: 'chunks'; sourceId: number; bufferId: number; config: VideoDecoderConfig; chunks: WireChunk[] }
  | { t: 'removeBuffer'; sourceId: number; bufferId: number };

export type HookCommand = { t: 'want'; sourceId: number } | { t: 'drop'; sourceId: number };

export type TapRequest = { kind: 'mse'; objectUrl: string } | { kind: 'progressive'; url: string };

export type TapKind = 'mse' | 'progressive' | 'none';

export interface OpenAnalysis {
  t: 'open';
  sessionId: string;
  tap: TapRequest;
  live: boolean;
  suspicionThreshold: number;
  inputSize: number;
  cacheKey: string;
  sourceUrl: string;
  hostname: string;
  scoreThreshold: number;
}

export type ContentToHost =
  | OpenAnalysis
  | { t: 'playhead'; sessionId: string; playhead: Playhead }
  | { t: 'visible'; sessionId: string; visible: boolean }
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
  | { t: 'cacheRead'; requestId: number; sessionId: string }
  | { t: 'cachePublish'; sessionId: string; samples: StoredSample[] }
  | { t: 'toHook'; command: HookCommand };

export const isArrayBufferTag = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';
